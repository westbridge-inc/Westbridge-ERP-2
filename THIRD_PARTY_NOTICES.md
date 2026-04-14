# Third-Party Notices (Backend)

This product includes third-party open source software components.

## How to generate an up-to-date notice list

From the repository root:

```bash
npm ci
npx --yes license-checker --production --summary
```

If you need a machine-readable report for due diligence:

```bash
npx --yes license-checker --production --json > third-party-licenses.json
```

## Notes

- This repository is licensed under the terms in [`LICENSE`](LICENSE).
- Third-party packages are governed by their respective licenses.
