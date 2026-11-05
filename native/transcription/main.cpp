#include <transcribe.h>
#include <algorithm>
#include <thread>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {
constexpr uint32_t max_samples = 16000 * 60 * 60;
enum Operation : uint32_t { warm, begin, feed, finish, cancel, batch };
using Model = std::unique_ptr<transcribe_model, decltype(&transcribe_model_free)>;
using Session = std::unique_ptr<transcribe_session, decltype(&transcribe_session_free)>;

// Output is JSON lines; input is a 12-byte LE header (operation, id, sample
// count), followed by count little-endian float32 samples. No audio in logs.
std::string quoted(const char *value) {
    std::string out = "\"";
    for (const unsigned char c : std::string(value ? value : "")) {
        if (c == '"' || c == '\\') { out += '\\'; out += c; }
        else if (c < 32) {
            char escape[7];
            std::snprintf(escape, sizeof(escape), "\\u%04x", c);
            out += escape;
        } else out += c;
    }
    return out + '"';
}

void reply(uint32_t id, const char *error = nullptr, const char *text = nullptr,
           const char *stable = "", const char *tentative = "") {
    std::cout << "{\"id\":" << id << ",\"error\":" << (error ? quoted(error) : "null")
              << ",\"transcript\":" << (text ? quoted(text) : "null")
              << ",\"stable\":" << quoted(stable)
              << ",\"tentative\":" << quoted(tentative) << "}\n" << std::flush;
}

uint32_t word(const unsigned char *bytes) {
    return uint32_t(bytes[0]) | uint32_t(bytes[1]) << 8 |
           uint32_t(bytes[2]) << 16 | uint32_t(bytes[3]) << 24;
}

void check(transcribe_status status) {
    if (status != TRANSCRIBE_OK) throw std::runtime_error(transcribe_status_string(status));
}

class Transcriber {
    const char *path;
    Model model{nullptr, transcribe_model_free};
    Session session{nullptr, transcribe_session_free};
    std::vector<float> audio;
    bool recording = false;
    bool streaming = false;
    bool probed = false;
    bool stream_available = false;

    void prepare() {
        if (!model) {
            check(transcribe_init_backends_default());
            transcribe_model *loaded = nullptr;
            auto status = transcribe_model_load_file(path, nullptr, &loaded);
            if (status != TRANSCRIBE_OK) {
                transcribe_model_load_params options;
                transcribe_model_load_params_init(&options);
                options.backend = TRANSCRIBE_BACKEND_CPU;
                check(transcribe_model_load_file(path, &options, &loaded));
            }
            model.reset(loaded);
        }
        if (!session) {
            transcribe_session *created = nullptr;
            transcribe_session_params options;
            transcribe_session_params_init(&options);
            // Keep the existing desktop CPU budget: leave capacity for input
            // and rendering while the encoder runs. GPU decoding uses one.
            options.n_threads = std::min(4, std::max(1, int(std::thread::hardware_concurrency()) - 2));
            transcribe_device_info device;
            transcribe_device_info_init(&device);
            if (transcribe_device_get_info(transcribe_model_device(model.get()), &device) == TRANSCRIBE_OK &&
                (device.device_type == TRANSCRIBE_DEVICE_TYPE_GPU || device.device_type == TRANSCRIBE_DEVICE_TYPE_IGPU))
                options.n_threads = 1;
            const bool gpu = device.device_type == TRANSCRIBE_DEVICE_TYPE_GPU || device.device_type == TRANSCRIBE_DEVICE_TYPE_IGPU;
            check(transcribe_session_init(model.get(), &options, &created));
            session.reset(created);
            if (!probed) {
                probed = true;
                if (gpu) {
                    if (transcribe_stream_begin(session.get(), nullptr, nullptr) == TRANSCRIBE_OK) {
                        const std::vector<float> silence(8 * 16000, 0.0f);
                        stream_available = transcribe_stream_feed(session.get(), silence.data(), int(silence.size()), nullptr) == TRANSCRIBE_OK
                            && transcribe_stream_finalize(session.get(), nullptr) == TRANSCRIBE_OK;
                    }
                    session.reset();
                    created = nullptr;
                    check(transcribe_session_init(model.get(), &options, &created));
                    session.reset(created);
                }
            }
        }
    }

    void clear() {
        session.reset(); // Release stream audio and scratch; retain only weights.
        std::vector<float>().swap(audio);
        recording = streaming = false;
    }

public:
    explicit Transcriber(const char *model_path) : path(model_path) {}

    void run(uint32_t operation, uint32_t id, const std::vector<float> &samples) {
        try {
            if (operation == cancel) { clear(); reply(id); return; }
            prepare();
            if (operation == warm) { reply(id); return; }
            if (operation == begin) {
                clear();
                prepare();
                recording = true;
                // A model/device that cannot stream still records every sample.
                streaming = stream_available && transcribe_stream_begin(session.get(), nullptr, nullptr) == TRANSCRIBE_OK;
                reply(id);
                return;
            }
            if (operation == batch) {
                if (recording) throw std::runtime_error("Voice recording is in progress");
                check(transcribe_run(session.get(), samples.data(), int(samples.size()), nullptr));
                reply(id, nullptr, transcribe_full_text(session.get()));
                clear();
                return;
            }
            if (!recording) throw std::runtime_error("Voice stream is no longer active");
            if (operation == feed) {
                if (samples.size() > max_samples - audio.size())
                    throw std::runtime_error("Voice recording exceeds the 60 minute limit");
                audio.insert(audio.end(), samples.begin(), samples.end());
                if (streaming && transcribe_stream_feed(session.get(), samples.data(), int(samples.size()), nullptr) != TRANSCRIBE_OK)
                    streaming = false;
                transcribe_stream_text text;
                transcribe_stream_text_init(&text);
                if (streaming && transcribe_stream_get_text(session.get(), &text) == TRANSCRIBE_OK)
                    reply(id, nullptr, nullptr, text.committed_text, text.tentative_text);
                else reply(id);
                return;
            }
            if (operation != finish) throw std::runtime_error("Unknown transcription operation");
            bool completed = streaming && transcribe_stream_finalize(session.get(), nullptr) == TRANSCRIBE_OK;
            std::string text = completed ? transcribe_full_text(session.get()) : "";
            if (text.empty() && !audio.empty()) {
                session.reset();
                prepare();
                check(transcribe_run(session.get(), audio.data(), int(audio.size()), nullptr));
                text = transcribe_full_text(session.get());
            }
            reply(id, nullptr, text.c_str());
            clear();
        } catch (const std::exception &error) {
            clear();
            reply(id, error.what());
        }
    }
};
}

int main(int argc, char **argv) {
    if (argc == 2 && std::strcmp(argv[1], "--probe") == 0) {
        if (transcribe_init_backends_default() != TRANSCRIBE_OK || !transcribe_backend_available(TRANSCRIBE_BACKEND_CPU)) return 1;
        std::cout << "solus-transcription/1 transcribe.cpp/" << transcribe_version() << " cpu-ready\n";
        return 0;
    }
    if (argc == 2 && std::strcmp(argv[1], "--version") == 0) {
        std::cout << "solus-transcription/1 transcribe.cpp/" << transcribe_version() << '\n';
        return 0;
    }
    if (argc != 2) { std::cerr << "Usage: solus-transcription MODEL.gguf\n"; return 2; }
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
#endif
    Transcriber transcriber(argv[1]);
    unsigned char header[12];
    while (std::cin.read(reinterpret_cast<char *>(header), sizeof(header))) {
        const auto operation = word(header), id = word(header + 4), count = word(header + 8);
        if (operation > batch || count > max_samples ||
            (operation != feed && operation != batch && count != 0) ||
            ((operation == feed || operation == batch) && count == 0)) return 2;
        std::vector<unsigned char> bytes(size_t(count) * 4);
        if (count && !std::cin.read(reinterpret_cast<char *>(bytes.data()), bytes.size())) return 2;
        std::vector<float> samples(count);
        for (uint32_t i = 0; i < count; ++i) {
            const auto bits = word(bytes.data() + i * 4);
            std::memcpy(&samples[i], &bits, 4);
            if (!std::isfinite(samples[i])) return 2;
        }
        transcriber.run(operation, id, samples);
    }
    return std::cin.gcount() == 0 ? 0 : 2;
}
