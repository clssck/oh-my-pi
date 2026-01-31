# oh-my-pi Fork Notes

## Repository Structure

```
pi-mono (badlogic/mariozechner)     ← Original source
    ↓ can1357 selectively ports
oh-my-pi (can1357/oh-my-pi)         ← Maintained fork with Bun focus
    ↓ we sync from can1357
our fork (clssck/oh-my-pi)          ← Our fixes on top
```

## Git Remotes

| Remote | Repo | Push |
|--------|------|------|
| `origin` | clssck/oh-my-pi | ✅ OK |
| `can1357` | can1357/oh-my-pi | ❌ Blocked |
| `upstream` | badlogic/pi-mono | ❌ Blocked (reference only) |

## Package Sync Status

| Package | Synced with | Notes |
|---------|-------------|-------|
| `packages/tui` | pi-mono | Ported: cursor nav, line jump, blockquotes, autocomplete |
| `packages/coding-agent` | pi-mono | Ported: ctx.getSystemPrompt(), OSC 52 clipboard, gitignore |
| `packages/ai` | **DIVERGED** | oh-my-pi has its own improvements; see Divergence section below |
| `packages/agent` | can1357 | Synced with oh-my-pi upstream |
| `packages/natives` | can1357 | Synced with oh-my-pi upstream |

## Porting Rules

**Full guide:** `docs/porting-from-pi-mono.md` (15 sections, detailed checklists)

**Quick reference:**
1. Remove `.js` extensions from imports
2. Replace `@mariozechner/*` with `@oh-my-pi/*`
3. Use Bun APIs where better (see guide for do/don't list)
4. Run `bun run check` before committing

## Our Unique Fixes

- `propertyNames` in UNSUPPORTED_SCHEMA_FIELDS (google-shared.ts) - NOT in pi-mono or oh-my-pi

## packages/ai Divergence

oh-my-pi and pi-mono have diverged significantly in packages/ai (~15k line diffs). oh-my-pi has its own improvements that pi-mono lacks:

| Feature | oh-my-pi | pi-mono |
|---------|----------|---------|
| Schema sanitization (UNSUPPORTED_SCHEMA_FIELDS) | ✅ 440 lines | ❌ 311 lines |
| Thought signature handling | ✅ Full | ✅ Full |
| `propertyNames` in schema filter | ✅ **Our fix** | ❌ |

Don't assume pi-mono is "ahead" - they've diverged in different directions. oh-my-pi has its own architecture and improvements.

## Handling Changes

**Syncing with can1357 (primary upstream):**
```bash
git fetch can1357 && git merge can1357/main
```

**Porting from pi-mono (when oh-my-pi is behind):**
- Check if can1357 already has it first
- Adapt imports (no `.js`, use `@oh-my-pi/*`)
- Test before committing
- Keep our unique fixes on top

**Key principle:** oh-my-pi is the real upstream. pi-mono features flow through can1357's curation. We supplement, not replace.

**When can1357 implements something we already ported:**

Merge conflicts may occur if we ported from pi-mono and can1357 later ports the same feature differently.

```bash
# If conflict occurs:
git checkout --theirs <conflicting-file>  # prefer can1357's version
git add .
git commit
```

Then check if we lost anything unique and re-add just that piece. Staying aligned with can1357 reduces future merge pain.

## CI & Commits

Every push triggers CI. Batch changes when possible to avoid burning GitHub Actions minutes. Don't auto-commit after every edit.
