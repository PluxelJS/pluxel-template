import { Context } from "@pluxel/hmr";
import { PinoLoggerService } from "@pluxel/hmr/services";

const ctx = new Context({
	hmrService: { dir: ["./src/ui-plugins", "."], deps: {
		cjsExternal: ['pluxel-plugin-napi-rs/*', '@napi-rs/*', '@memecrafters/meme-generator'],
	}, },
	registry: {
		startStrategy: "ready-queue",
		pluginCTXIsolate: [PinoLoggerService],
	},
	logger: {
		level: "debug",
	},
	graphql: {
		destination: "./gqty/index.ts",
	},
});

await ctx.hmrService.start();
ctx.honoService.modifyApp((app) => {
	app.get("/pluginadd", (c) => {
		return c.text("lastone");
	});
});
