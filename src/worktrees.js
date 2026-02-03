export function sanitizeBranchForRef(branch) {
  return branch
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^0-9A-Za-z._/-]/g, "-")
    .replace(/-+/g, "-");
}
