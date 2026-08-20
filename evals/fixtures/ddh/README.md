# ddh: domain-driven-hexagon, fetched on demand

The first external fixture. The project is [Sairyss/domain-driven-hexagon](https://github.com/Sairyss/domain-driven-hexagon), MIT licensed (Copyright (c) 2021 Sairyss), pinned at commit `5c2d15a7e2d69e83dfddf28468ee9f30e02c30de`. Its sources are not vendored here: `external.json` names the repository and the pin, the harness clones it into `evals/.cache/repos/` on demand, and every use verifies `git rev-parse HEAD` against the pin. The patches under `patches/` embed short fragments of the upstream code as diff context, which is why this attribution exists.

This directory holds only what we author:

- `external.json`, the repository URL and pin
- `arch/model.c4` and `fitc4.config.json`, the overlay copied onto the pinned sources per run
- `patches/*.patch`, one planted violation per patch, each named after the upstream rule it breaks
- `greenfield/` and `brownfield/`, the two fixture variants, each with its own `fitc4.eval.ts`, `replies.json`, and `expectations.json`

## What the model transcribes

The project states its own architecture twice: a long README, and a checked-in `.dependency-cruiser.js` with sixteen named forbidden rules (a seventeenth, `no-circular`, is commented out). The config is the source of truth, and the model transcribes it rather than inventing an architecture. Its five layer rules become the shape of the declared relationships: `no-domain-to-api-deps`, `no-domain-to-app-deps`, `no-domain-to-infra-deps`, and `no-infra-to-api-deps` are transcribed as the absence of those edges, including both documented exceptions, which appear as declared relationships (domain code may read `AppRequestContext`, and use cases may depend on infrastructure `port.ts` files). Every declared relationship is an edge the pinned code exercises and the upstream config permits.

Granularity is the honest limit. Upstream classifies single files into layers by name (`.service.ts$` is application, `controller.ts$` is api), while fitc4 ownership is directory prefixes, so the model works at the directory granularity this codebase already keeps: each module's `domain/`, `database/`, `dtos/`, `commands/`, and `queries/` directory is one element. That expresses four of the five layer rules faithfully. The fifth, `no-command-query-to-api-deps`, is not expressible: controllers legitimately live inside the `commands/` and `queries/` directories, so a service file reaching into the api layer is indistinguishable from its neighboring controller doing so legally.

The eleven preset rules are package and test hygiene, not layering. `not-to-unresolvable` and `no-non-package-json` correspond to fitc4's own `unresolved-import` rule, and one declared edge (`ddh -> vendor`) transcribes their flip side: anything declared in `package.json` may be imported, from any layer. `not-to-test` and `not-to-spec` are covered in part by fitc4 excluding test paths from the scan. `no-orphans`, `no-deprecated-core`, `not-to-deprecated`, `no-duplicate-dep-types`, `not-to-dev-dep`, `optional-deps-used`, and `peer-deps-used` reason about npm metadata fitc4 does not model, and are not transcribed.

## The two variants

**greenfield** runs the pinned sources unmodified. The deterministic gate is green, and `agentResolve` gets six candidate decisions: five `slonik` decisions whose one right mapping is the description-only `vendor.postgres` element, and `nanoid`, which no element covers, so the right behavior is abstention.

**brownfield** applies the four patches. Each plants one import that violates the named upstream rule, verified at authoring time by running the project's own dependency-cruiser config against the pristine and patched trees (baseline: zero violations across 284 dependencies; each patch: exactly its named rule fires). The transcribed model turns them into pinned findings:

| patch | planted import | expected finding |
| --- | --- | --- |
| `no-domain-to-infra-deps.patch` | `user.entity.ts` imports the concrete `user.repository` | `relationship-direction` error, the model declares only `user.database -> user.domain` |
| `no-domain-to-app-deps.patch` | `user.types.ts` imports the exception interceptor | `missing-relationship` error, `AppRequestContext` is the only exempted target |
| `no-domain-to-api-deps.patch` | `wallet.entity.ts` imports the shared response base | `missing-relationship` error |
| `no-infra-to-api-deps.patch` | `user.repository.ts` imports a response DTO | `missing-relationship` error |
