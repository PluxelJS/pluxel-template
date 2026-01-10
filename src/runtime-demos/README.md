# Runtime demos

This folder contains runtime-loadable demo plugins (not tests).

How to use:

1. Start HMR: `pnpm --filter @pluxel/hmr hmr`
2. Open the plugins page in the UI
3. Enable demo plugins and use the **依赖注入** panel:
   - Base providers: `DemoClock.System` / `DemoClock.Fixed` + `DemoClockConsumer`
   - KV providers (from package): `Kv` (pluxel-plugin-kv) / `Redis` (pluxel-plugin-redis) + `DemoKvConsumer`
   - Rates (best-effort): `Kv` + `Rates` (pluxel-plugin-kv)
   - Redis rates (atomic): `Redis` + `RedisRates` (pluxel-plugin-redis)
   - Forks: `DemoWorker` + `DemoWorkerConsumer`
