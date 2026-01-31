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
| `packages/ai` | **BEHIND** | NOT ported: schema sanitization, tool ID fixes, caching improvements |
| `packages/agent` | can1357 | Synced with oh-my-pi upstream |
| `packages/natives` | can1357 | Synced with oh-my-pi upstream |

## Porting Rules (from docs/porting-from-pi-mono.md)

1. Remove `.js` extensions from imports (oh-my-pi doesn't use them)
2. Replace `@mariozechner/*` with `@oh-my-pi/*`
3. Use Bun APIs where better
4. Test thoroughly before committing

## Our Unique Fixes

- `propertyNames` in UNSUPPORTED_SCHEMA_FIELDS (google-shared.ts) - NOT in pi-mono or oh-my-pi

## TODO: AI Package Improvements from pi-mono

**High Priority (Bug Fixes):**
- [ ] Schema sanitization for Google (google-shared.ts) - prevents API rejections
- [ ] Tool call ID sanitization (anthropic.ts) - fixes invalid ID errors
- [ ] Empty text block filtering (google-shared.ts) - prevents empty message errors
- [ ] Vertex AI `id` field deletion (google-shared.ts) - Vertex compatibility

**Medium Priority:**
- [ ] `headers` option in StreamOptions (types.ts) - custom HTTP headers
- [ ] Enhanced prompt caching (anthropic.ts) - better cache hit rates
- [ ] Retry-after error formatting (anthropic.ts) - clearer rate limit errors
- [ ] Beta header management (anthropic.ts) - cleaner beta flag handling

## Workflow

1. **Stay synced with can1357** - `git fetch can1357 && git merge can1357/main`
2. **Cherry-pick pi-mono features** - Adapt imports, test, commit
3. **Add our fixes on top** - Keep unique value (like propertyNames)
4. **Don't force-sync pi-mono** - Let can1357 curate, we supplement
