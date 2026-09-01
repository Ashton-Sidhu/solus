function slugifyBranch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')
}

export function worktreeBranchName(prompt: string, generatedName?: string | null): string {
  const slug = slugifyBranch(generatedName || prompt)
  const short = Math.random().toString(36).slice(2, 7)
  return `solus/${slug || 'task'}-${short}`
}
