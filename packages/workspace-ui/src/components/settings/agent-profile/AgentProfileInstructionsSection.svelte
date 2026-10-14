<script lang="ts">
  /**
   * Settings → Agent profile → Instructions: the person's own instructions, a
   * personal setting every prompt carries (plans/018 §3.1), so they follow the
   * person to every host like the rest of the profile. The home's CLAUDE.md
   * and AGENTS.md are not here: they belong with a project.
   */
  import SettingsTextField from "../SettingsTextField.svelte";
  import { getSettingsContext } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";

  const theme = getSettingsContext();
</script>

<SettingsSection label="Instructions" description="Your own instructions, sent with every prompt on every host. A project's CLAUDE.md or AGENTS.md stays with the project.">
  <SettingsRow label="Extra instructions" description="Appended to the system prompt for every agent run." testId="agent-profile-extra-instructions">
    {#snippet body()}
      <!-- Matches the message composer: accent focus ring and a forced 400
           weight so typed text never reads bold. The placeholder uses the
           smaller workspace-chrome type rung. -->
      <SettingsTextField
        label="Extra instructions"
        value={theme.extraInstructions}
        onValueChange={(md) => theme.setPersonal("extraInstructions", md)}
        onBlur={() => requestInputFocus()}
        placeholder="Prefer concise answers. Use specific libraries. Follow my writing style."
        class="rounded-lg border border-input bg-white dark:bg-input/30 px-3 [--plain-editor-line-height:1.5] [--plain-editor-padding:0.625rem_0] transition-[border-color,box-shadow] focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.cm-content]:![min-height:4.5rem] [&_.cm-content]:![font-weight:400] [&_.cm-placeholder]:text-workspace-chrome"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>
