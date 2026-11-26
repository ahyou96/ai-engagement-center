# Dependencies & licenses

Direct dependencies (versions as installed; read from `node_modules/*/package.json`):

| Package | Version | License | Scope |
|---|---|---|---|
| @xyflow/react | 12.12.1 | MIT | runtime |
| better-sqlite3 | 12.11.1 | MIT | runtime |
| clsx | 2.1.1 | MIT | runtime |
| echarts | 5.6.0 | Apache-2.0 | runtime |
| echarts-for-react | 3.1.0 | MIT | runtime |
| lucide-react | 1.80.0 | ISC | runtime |
| next | 16.0.10 | MIT | runtime |
| react / react-dom | 19.2.0 | MIT | runtime |
| zod | 3.25.76 | MIT | runtime |
| tailwindcss / @tailwindcss/postcss | 4.3.5 | MIT | dev |
| typescript | 5.9.3 | Apache-2.0 | dev |
| vitest | 3.2.7 | MIT | dev |
| tsx | 4.23.15 | MIT | dev |
| @types/* | – | MIT | dev |

Transitive license summary (all installed packages, macOS arm64): MIT 119, ISC 18, Apache-2.0 8, BSD-3-Clause 4, MPL-2.0 2,
LGPL-3.0-or-later 1, CC-BY-4.0 1, BlueOak-1.0.0 1, 0BSD 1, dual-licensed 2.

Items needing legal review before distribution:

| Package | License | Why it is present | Note |
|---|---|---|---|
| @img/sharp-libvips-* | LGPL-3.0-or-later | Next.js optional image optimisation (sharp) | Dynamically linked native lib; the app does not use `next/image` optimisation. Can be excluded in production images. |
| lightningcss | MPL-2.0 | Tailwind v4 build tool | Build-time only; file-level copyleft. |
| caniuse-lite | CC-BY-4.0 | Browserslist data | Build-time data. |

Not used (evaluated only — see ARCHITECTURE.md): Unomi, Tracardi, RudderStack, PostHog, ClickHouse, Kafka, Flink, Feast, Mautic, Novu,
Chatwoot, Activepieces, Temporal, GrowthBook, MLflow, Optuna, OPA, Keycloak, Vercel AI SDK, LangGraph, Dify, Langfuse.
A full machine-generated SBOM was not produced in this build (the license-checker download was not permitted); generate one with
your organisation's approved SBOM tool before release.
