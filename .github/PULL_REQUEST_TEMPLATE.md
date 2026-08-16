<!--
Contributions are under the Elastic License 2.0 and the DCO — sign commits with
`git commit -s`. See CONTRIBUTING.md.
-->

## What this changes

<!-- The behaviour that differs afterwards, in a sentence or two. -->

## Why

<!-- The problem. If there is an issue, link it. If you hit this yourself, say
     what you were doing — that context usually outlives the fix. -->

## How it was verified

<!-- What you actually ran, not what should work. "npm test" plus the specific
     thing you exercised by hand. If you could not test part of it, say which
     part — that is far more useful than silence. -->

## Checklist

- [ ] `npm run build` passes (typechecks every workspace)
- [ ] `npm test` passes
- [ ] Commits signed off (`git commit -s`)
- [ ] No secrets in the diff, including in test fixtures and pasted logs

<!--
Adding a new AI tool backend? It should be one new file under
packages/engine/src/core/backends/ and one line in that directory's index.ts.
If you needed to change the engine to make it work, mention it — that means the
abstraction is missing something and the fix probably belongs there instead.
-->
