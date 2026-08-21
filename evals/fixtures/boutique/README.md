# boutique: Online Boutique, fetched on demand

The second external fixture, and the first to marry the external-fetch machinery to `agentScan`. The project is [GoogleCloudPlatform/microservices-demo](https://github.com/GoogleCloudPlatform/microservices-demo) (Online Boutique), Apache-2.0 licensed (Copyright Google LLC), pinned at commit `5b3a712ab85ccb8f6f7cd5b720d36ba9a8d041eb` (tag v0.10.6). Its sources are not vendored here: `external.json` names the repository and the pin, the harness clones it into `evals/.cache/repos/` on demand, and every use verifies `git rev-parse HEAD` against the pin. The patch under `patches/` embeds a short fragment of one upstream manifest as diff context, which is why this attribution exists.

This directory holds only what we author:

- `external.json`, the repository URL and pin
- `arch/model.c4`, the overlay copied onto the pinned sources per run
- `patches/recommendation-to-payment.patch`, the one planted violation
- `greenfield/`, `brownfield/`, and `draft/`, the three fixture variants, each with its own eval spec, `replies.json`, and `expectations.json` (`draft/` carries a `draft.eval.ts` instead of a pipeline spec, because it measures `fitc4 draft` rather than the gate)

## What the model transcribes

The project documents its architecture in the README's service table and architecture diagram, and states it machine-readably in `kubernetes-manifests/`: every service manifest declares its outbound edges as container env vars named `*_SERVICE_ADDR`, whose value is `<target>:<port>` with the target service's name as the host. The model transcribes that declared graph and nothing else, fifteen relationships: eight from the frontend (including `SHOPPING_ASSISTANT_SERVICE_ADDR`, which the frontend declares even though the shopping assistant's own manifest ships as an optional kustomize component), six from the checkout service, and one from the recommendation service. The transcription is verified mechanically at authoring time by extracting every `*_SERVICE_ADDR` env var from the pristine manifests and diffing the edge list against the model's relationships; the diff is empty.

Two documented edges sit outside that naming convention and are declared for fidelity but not exercised by the scan: the cart service reaches redis via `REDIS_ADDR`, and the load generator reaches the frontend via `FRONTEND_ADDR`. The redis-cart Deployment ships inside `cartservice.yaml` itself and no code in this repository implements it, so `redis` stays a description-only element, and the expectations pin the `unobserved-elements` info finding that reports it.

Ownership follows the non-ts fixture's precedent, because fitc4 ownership is a directory prefix and the flat manifest files cannot own themselves: each service owns its build directory `src/<name>/`, and the file `src/<name>/Dockerfile` stands in for the service wherever a fact needs a file (cartservice's Dockerfile lives at `src/cartservice/src/Dockerfile`). This is also why the fixture fetches a plain blobless clone rather than a sparse one: the stand-in files that ground every service live under `src/`, so a manifests-only checkout could not ground the model.

## The three variants

**greenfield** runs the pinned manifests unmodified. `agentScan` runs in focused one-shot mode over `kubernetes-manifests/*.yaml`: the manifests' contents are embedded in the request, the ideal reply reports each `*_SERVICE_ADDR` env var as a `dependency` observation between the stand-in files, and `examined[]` attests to all twelve manifests, including `kustomization.yaml`, `loadgenerator.yaml`, and the eight service manifests that contribute no edges. The stock resolver and rules judge the fifteen edges exactly as they judge imports, every one resolves onto a declared relationship, and the gate is green.

**brownfield** applies the one patch: `recommendationservice.yaml` gains a `PAYMENT_SERVICE_ADDR` env var pointing the recommendation service at the payment service, written exactly the way every declared edge in these manifests is written (verified mechanically: the same extraction over the patched tree yields exactly one extra edge). The expectations pin the resulting `missing-relationship` error and that the scan reports the planted edge honestly rather than tidying it away. That is this fixture's point: the agent's observations are the gate's only coverage of this domain, so a wrong or missing observation changes the findings by construction.

**draft** turns the same scan around. Instead of gating the manifests against the transcribed model, it runs `fitc4 draft` in its natural condition, no model anywhere, and asks whether the bootstrapped model is useful: `draft()` consumes the scan's observations, the `arch/` overlay is deliberately not copied in, and the drafted model is scored against this variant's `expectations.json`, the reference architecture restated as data (matching rules in `harness/draft.ts`). One divergence from the greenfield scan, because the files demanded it: `draft` derives its elements from `file` observations, and the dependency-only greenfield instructions produce none, so a draft fed that scan verbatim would contain no elements at all. The draft variant therefore appends one rule to the instructions, emit a `file` observation for each service's stand-in file, which is the same rule any user drafting from an agent-scan config would have to write.

A good draft here contains all twelve scannable services as elements, covers all fifteen `*_SERVICE_ADDR` relationships, and invents nothing. That is exactly what the recorded ideal scan yields, so the stub scorecard is, deterministically:

```text
boutique/draft  draft-edges     15  0  0  ok
boutique/draft  draft-elements  12  0  0  ok
```

The reference holds thirteen elements and seventeen relationships; the entries the draft cannot reach are marked `outsideScan` and score as neither misses nor extras: the description-only `redis` element (no code in the repository implements it) and the two edges outside the naming convention, `cartservice -> redis` and `loadgenerator -> frontend`. So the coverage arithmetic reads: 12 of 13 elements, 15 of 17 relationships, and the remainder is precisely the architecture that lives outside the scanned convention, unreachable from these manifests by construction. Stub mode demonstrates the drafting machinery, that a correct scan becomes a correct first model, and pins that boundary. Whether a real model's scan drafts the same model is what a live run (`--exec claude` or `--exec codex`) measures.
