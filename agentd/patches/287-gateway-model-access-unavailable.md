# 287: say when LibraOS model access is unavailable

A cloud job on LibraOS model access fails when the hosted gateway has no usable credential for the provider. The gateway answers `503 auth_unavailable: no auth available`, and the Job API may still end the job as `failed_verification`, so the task showed "The changes did not pass the check." The job's result now gives one line instead: LibraOS model access couldn't reach the model provider, this isn't the user's key, account or code, and they can try again later or use their own subscription or API key. The line doesn't quote the gateway's internal management path.

The pattern is the gateway's own wording (`503 auth_unavailable`, `no auth available`) and is checked before the sign-in patterns, because the gateway's message quotes its upstream's 401 and refresh-token error. It is not a refusal before a task, since the job was created and ran.

Upstream files touched: none.

- `apps/server/src/agentd/cloudFailure.ts`: the `gatewayUnavailable` reason and its pattern.
- `apps/server/src/agentd/cloudFailure.test.ts`: a redacted copy of the reported error in `failed_verification` and `failed` jobs, and paths and messages with `auth` or `503` that keep their earlier reasons.

No platform-specific code. The reason is server-side English text like the other cloud reasons, which are not translated.
