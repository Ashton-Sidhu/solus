// Runs the mobile module's C build of @pierre/highlights on the cases in a
// file and writes the records it returns, for
// tests/unit/native-mobile-highlights-native.test.ts.
//
// Input: repeated [u8 language][u32 byte length][UTF-8 bytes].
// Output: per case [i64 count][count x u32 records]. Little-endian.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include "solus_highlights.h"

static int read_exact(FILE* file, void* into, size_t length) {
  return fread(into, 1, length, file) == length;
}

int main(int argc, char** argv) {
  if (argc != 3) return 2;
  FILE* input = fopen(argv[1], "rb");
  FILE* output = fopen(argv[2], "wb");
  if (input == NULL || output == NULL) return 2;

  uint8_t language;
  while (read_exact(input, &language, 1)) {
    uint32_t length;
    if (!read_exact(input, &length, 4)) return 3;
    uint8_t* source = malloc(length > 0 ? length : 1);
    if (source == NULL || !read_exact(input, source, length)) return 3;
    const uint32_t* records = NULL;
    int64_t count = solus_highlights_tokenize(source, length, language, &records);
    fwrite(&count, sizeof(count), 1, output);
    if (count > 0) fwrite(records, sizeof(uint32_t), (size_t)count, output);
    free(source);
  }
  fclose(output);
  fclose(input);
  return 0;
}
