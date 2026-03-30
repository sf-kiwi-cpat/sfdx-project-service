# Known Issues & Workarounds

Lessons learned from real failures — deprecated APIs, silent errors,
and platform quirks. Check here before assuming a CLI command or API
works as documented.

When you encounter a new issue (deprecated API, silent failure, unreliable
flag, platform quirk), add it here with:
1. **What failed** — the command or pattern that broke
2. **Why** — root cause if known
3. **Workaround** — the reliable replacement

---

## GitHub CLI (`gh`)

### `--label` and `--assignee` flags silently miss results

**What failed:** `gh pr list --label X` and `gh issue list --assignee Y`
return incomplete results.

**Why:** Label color encoding issues and other gh CLI bugs cause filters
to silently skip matching items.

**Workaround:** Fetch broadly and filter client-side with `jq`:
```bash
gh pr list --state open --json number,labels,assignees \
  --jq '[.[] | select(.labels | map(.name) | index("spec:agent-reviewing"))]'
```

### `gh issue/pr edit --add-label` silently fails

**What failed:** `gh issue edit $N --add-label X` and
`gh pr edit $N --add-label X` exit with an error or silently no-op.

**Why:** Projects Classic deprecation causes `gh edit` to hit a GraphQL
error (`Projects (classic) is being deprecated...`) that prevents the
label mutation from applying.

**Workaround:** Use the REST API directly. PRs are issues in the GitHub
API, so one endpoint handles both:
```bash
# Add label
gh api repos/{owner}/{repo}/issues/$NUMBER/labels --method POST -f 'labels[]=label-name'

# Remove label (|| true: no-op if label doesn't exist)
gh api repos/{owner}/{repo}/issues/$NUMBER/labels/label-name --method DELETE 2>/dev/null || true
```

### Deleting a GH Actions workflow file doesn't remove its required status check

**What failed:** Deleting a workflow `.yml` file leaves its status check
as a required check on the branch protection rule, blocking merges.

**Why:** GitHub decouples workflow files from branch protection rules.

**Workaround:**
```bash
gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks \
  -X PATCH --input <(echo '{"strict":true,"contexts":[]}')
```
