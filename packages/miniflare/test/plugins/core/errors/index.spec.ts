import assert from "assert";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import test from "ava";
import Protocol from "devtools-protocol";
import esbuild from "esbuild";
import { DeferredPromise, fetch, Log, LogLevel, Miniflare } from "miniflare";
import NodeWebSocket from "ws";
import { escapeRegexpComponent, useTmp } from "../../../test-shared";
import type { RawSourceMap } from "source-map";

const FIXTURES_PATH = path.resolve(
	__dirname,
	"..",
	"..",
	"..",
	"..",
	"..",
	"test",
	"fixtures",
	"source-maps"
);
const SERVICE_WORKER_ENTRY_PATH = path.join(FIXTURES_PATH, "service-worker.ts");
const MODULES_ENTRY_PATH = path.join(FIXTURES_PATH, "modules.ts");
const DEP_ENTRY_PATH = path.join(FIXTURES_PATH, "nested/dep.ts");
const REDUCE_PATH = path.join(FIXTURES_PATH, "reduce.ts");

function pathOrUrlRegexp(filePath: string): `(${string}|${string})` {
	return `(${escapeRegexpComponent(filePath)}|${escapeRegexpComponent(
		pathToFileURL(filePath).href
	)})`;
}

test("source maps workers", async (t) => {
	// Build fixtures
	const tmp = await useTmp(t);
	await esbuild.build({
		entryPoints: [
			SERVICE_WORKER_ENTRY_PATH,
			MODULES_ENTRY_PATH,
			DEP_ENTRY_PATH,
		],
		format: "esm",
		bundle: true,
		sourcemap: true,
		outdir: tmp,
	});
	const serviceWorkerPath = path.join(tmp, "service-worker.js");
	const modulesPath = path.join(tmp, "modules.js");
	const depPath = path.join(tmp, "nested", "dep.js");
	const serviceWorkerContent = await fs.readFile(serviceWorkerPath, "utf8");
	const modulesContent = await fs.readFile(modulesPath, "utf8");

	const mf = new Miniflare({
		inspectorPort: 0,
		workers: [
			{
				bindings: { MESSAGE: "unnamed" },
				scriptPath: serviceWorkerPath,
			},
			{
				name: "a",
				routes: ["*/a"],
				bindings: { MESSAGE: "a" },
				script: serviceWorkerContent,
				scriptPath: serviceWorkerPath,
			},
			{
				name: "b",
				routes: ["*/b"],
				modules: true,
				scriptPath: modulesPath,
				bindings: { MESSAGE: "b" },
			},
			{
				name: "c",
				routes: ["*/c"],
				bindings: { MESSAGE: "c" },
				modules: true,
				script: modulesContent,
				scriptPath: modulesPath,
			},
			{
				name: "d",
				routes: ["*/d"],
				bindings: { MESSAGE: "d" },
				modules: [{ type: "ESModule", path: modulesPath }],
			},
			{
				name: "e",
				routes: ["*/e"],
				bindings: { MESSAGE: "e" },
				modules: [
					{ type: "ESModule", path: modulesPath, contents: modulesContent },
				],
			},
			{
				name: "f",
				routes: ["*/f"],
				bindings: { MESSAGE: "f" },
				modulesRoot: tmp,
				modules: [{ type: "ESModule", path: modulesPath }],
			},
			{
				name: "g",
				routes: ["*/g"],
				bindings: { MESSAGE: "g" },
				modules: true,
				modulesRoot: tmp,
				scriptPath: modulesPath,
			},
			{
				name: "h",
				routes: ["*/h"],
				modules: [
					// Check importing module with source map (e.g. Wrangler no bundle with built dependencies)
					{
						type: "ESModule",
						path: modulesPath,
						contents: `import { createErrorResponse } from "./nested/dep.js"; export default { fetch: createErrorResponse };`,
					},
					{ type: "ESModule", path: depPath },
				],
			},
			{
				name: "i",
				// Generated with `esbuild --sourcemap=inline --sources-content=false worker.ts`
				script: `"use strict";
addEventListener("fetch", (event) => {
  event.respondWith(new Response("body"));
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsid29ya2VyLnRzIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFBLGlCQUFpQixTQUFTLENBQUMsVUFBVTtBQUNuQyxRQUFNLFlBQVksSUFBSSxTQUFTLE1BQU0sQ0FBQztBQUN4QyxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
`,
			},
		],
	});
	t.teardown(() => mf.dispose());

	// Check service-workers source mapped
	let error = await t.throwsAsync(mf.dispatchFetch("http://localhost"), {
		message: "unnamed",
	});
	const serviceWorkerEntryRegexp = new RegExp(
		`${pathOrUrlRegexp(SERVICE_WORKER_ENTRY_PATH)}:6:16`
	);
	t.regex(String(error?.stack), serviceWorkerEntryRegexp);
	error = await t.throwsAsync(mf.dispatchFetch("http://localhost/a"), {
		message: "a",
	});
	t.regex(String(error?.stack), serviceWorkerEntryRegexp);

	// Check modules workers source mapped
	error = await t.throwsAsync(mf.dispatchFetch("http://localhost/b"), {
		message: "b",
	});
	const modulesEntryRegexp = new RegExp(
		`${pathOrUrlRegexp(MODULES_ENTRY_PATH)}:5:17`
	);
	t.regex(String(error?.stack), modulesEntryRegexp);
	error = await t.throwsAsync(mf.dispatchFetch("http://localhost/c"), {
		message: "c",
	});
	t.regex(String(error?.stack), modulesEntryRegexp);
	error = await t.throwsAsync(mf.dispatchFetch("http://localhost/d"), {
		message: "d",
	});
	t.regex(String(error?.stack), modulesEntryRegexp);
	error = await t.throwsAsync(mf.dispatchFetch("http://localhost/e"), {
		message: "e",
	});
	t.regex(String(error?.stack), modulesEntryRegexp);
	error = await t.throwsAsync(mf.dispatchFetch("http://localhost/f"), {
		message: "f",
	});
	t.regex(String(error?.stack), modulesEntryRegexp);
	error = await t.throwsAsync(mf.dispatchFetch("http://localhost/g"), {
		message: "g",
	});
	t.regex(String(error?.stack), modulesEntryRegexp);
	error = await t.throwsAsync(mf.dispatchFetch("http://localhost/h"), {
		instanceOf: TypeError,
		message: "Dependency error",
	});
	const nestedRegexp = new RegExp(`${pathOrUrlRegexp(DEP_ENTRY_PATH)}:4:16`);
	t.regex(String(error?.stack), nestedRegexp);

	// Check source mapping URLs rewritten
	const inspectorBaseURL = await mf.getInspectorURL();
	let sources = await getSources(inspectorBaseURL, "core:user:");
	t.deepEqual(sources, [REDUCE_PATH, SERVICE_WORKER_ENTRY_PATH]);
	sources = await getSources(inspectorBaseURL, "core:user:a");
	t.deepEqual(sources, [REDUCE_PATH, SERVICE_WORKER_ENTRY_PATH]);
	sources = await getSources(inspectorBaseURL, "core:user:b");
	t.deepEqual(sources, [MODULES_ENTRY_PATH, REDUCE_PATH]);
	sources = await getSources(inspectorBaseURL, "core:user:c");
	t.deepEqual(sources, [MODULES_ENTRY_PATH, REDUCE_PATH]);
	sources = await getSources(inspectorBaseURL, "core:user:d");
	t.deepEqual(sources, [MODULES_ENTRY_PATH, REDUCE_PATH]);
	sources = await getSources(inspectorBaseURL, "core:user:e");
	t.deepEqual(sources, [MODULES_ENTRY_PATH, REDUCE_PATH]);
	sources = await getSources(inspectorBaseURL, "core:user:f");
	t.deepEqual(sources, [MODULES_ENTRY_PATH, REDUCE_PATH]);
	sources = await getSources(inspectorBaseURL, "core:user:g");
	t.deepEqual(sources, [MODULES_ENTRY_PATH, REDUCE_PATH]);
	sources = await getSources(inspectorBaseURL, "core:user:h");
	t.deepEqual(sources, [DEP_ENTRY_PATH, REDUCE_PATH]); // (entry point script overridden)

	// Check respects map's existing `sourceRoot`
	const sourceRoot = "a/b/c/d/e";
	const serviceWorkerMapPath = serviceWorkerPath + ".map";
	const serviceWorkerMap: RawSourceMap = JSON.parse(
		await fs.readFile(serviceWorkerMapPath, "utf8")
	);
	serviceWorkerMap.sourceRoot = sourceRoot;
	await fs.writeFile(serviceWorkerMapPath, JSON.stringify(serviceWorkerMap));
	t.deepEqual(await getSources(inspectorBaseURL, "core:user:"), [
		path.resolve(tmp, sourceRoot, path.relative(tmp, REDUCE_PATH)),
		path.resolve(
			tmp,
			sourceRoot,
			path.relative(tmp, SERVICE_WORKER_ENTRY_PATH)
		),
	]);

	// Check does nothing with URL source mapping URLs
	const sourceMapURL = await getSourceMapURL(inspectorBaseURL, "core:user:i");
	t.regex(sourceMapURL, /^data:application\/json;base64/);
});

function getSourceMapURL(
	inspectorBaseURL: URL,
	serviceName: string
): Promise<string> {
	let sourceMapURL: string | undefined;
	const promise = new DeferredPromise<string>();
	const inspectorURL = new URL(`/${serviceName}`, inspectorBaseURL);
	const ws = new NodeWebSocket(inspectorURL);
	ws.on("message", async (raw) => {
		try {
			const message = JSON.parse(raw.toString("utf8"));
			if (message.method === "Debugger.scriptParsed") {
				const params: Protocol.Debugger.ScriptParsedEvent = message.params;
				if (params.sourceMapURL === undefined || params.sourceMapURL === "") {
					return;
				}
				// If sourceMapURL is relative
				sourceMapURL = new URL(
					params.sourceMapURL,
					!params.url.startsWith("script-") ? params.url : undefined
				).toString();
				ws.close();
			}
		} catch (e) {
			promise.reject(e);
		}
	});
	ws.on("open", () => {
		ws.send(JSON.stringify({ id: 0, method: "Debugger.enable", params: {} }));
	});
	ws.on("close", () => {
		assert(sourceMapURL !== undefined, "Expected `sourceMapURL`");
		promise.resolve(sourceMapURL);
	});
	return promise;
}

async function getSources(inspectorBaseURL: URL, serviceName: string) {
	const sourceMapURL = await getSourceMapURL(inspectorBaseURL, serviceName);
	assert(sourceMapURL.startsWith("file:"));
	const sourceMapPath = fileURLToPath(sourceMapURL);
	const sourceMapData = await fs.readFile(sourceMapPath, "utf8");
	const sourceMap: RawSourceMap = JSON.parse(sourceMapData);
	return sourceMap.sources
		.map((source) => {
			if (sourceMap.sourceRoot) {
				source = path.posix.join(sourceMap.sourceRoot, source);
			}
			return fileURLToPath(new URL(source, sourceMapURL));
		})
		.sort();
}

class CustomLog extends Log {
	logs: [LogLevel, string][] = [];

	log(message: string): void {
		this.logs.push([LogLevel.NONE, message]);
	}

	logWithLevel(level: LogLevel, message: string) {
		this.logs.push([level, message]);
	}

	getLogs(level: LogLevel): string[] {
		return this.logs
			.filter(([logLevel]) => logLevel === level)
			.map(([, message]) => message);
	}
}

test("responds with pretty error page", async (t) => {
	const log = new CustomLog();
	const mf = new Miniflare({
		log,
		modules: true,
		script: `
		import { connect } from "cloudflare:sockets";

		// A function to test error thrown by native code
		async function connectSocket(request) {
			try {
				// The following line will throw an error because the port is invalid
				const socket = connect({ hostname: "gopher.floodgap.com", port: "invalid" });

				const writer = socket.writable.getWriter();
				const url = new URL(request.url);
				const encoder = new TextEncoder();
				const encoded = encoder.encode(url.pathname + "\\r\\n");
				await writer.write(encoded);
				await writer.close();

				return new Response(socket.readable, {
					headers: { "Content-Type": "text/plain" },
				});
			} catch (e) {
				throw new Error("Unusual oops!", {
					cause: e,
				});
			}
		}

		// This emulates the reduceError function in the Wrangler middleware template
		// See packages/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
		function reduceError(e) {
			return {
				name: e?.name,
				message: e?.message ?? String(e),
				stack: e?.stack,
				cause: e?.cause === undefined ? undefined : reduceError(e.cause),
			};
		}

		export default {
			async fetch(request) {
				try {
					return await connectSocket(request);
				} catch (e) {
					const error = reduceError(e);
					return Response.json(error, {
						status: 500,
						headers: { "MF-Experimental-Error-Stack": "true" },
					});
				}
			},
		}`,
	});
	t.teardown(() => mf.dispose());
	const url = new URL("/some-unusual-path", await mf.ready);

	// Check `fetch()` returns pretty-error page...
	let res = await fetch(url, {
		method: "POST",
		headers: { "X-Unusual-Key": "some-unusual-value" },
	});
	t.is(res.status, 500);
	t.regex(res.headers.get("Content-Type") ?? "", /^text\/html/);
	const text = await res.text();
	// ...including error, request method, URL and headers
	t.regex(text, /Unusual oops!/);
	t.regex(text, /Method.+POST/is);
	t.regex(text, /URL.+some-unusual-path/is);
	t.regex(text, /X-Unusual-Key.+some-unusual-value/is);
	// Check if the stack trace is included
	t.regex(text, /cloudflare\:sockets/);
	t.regex(text, /connectSocket/);
	t.regex(text, /connect/);
	t.regex(text, /Object\.fetch/);

	// Check error logged
	const errorLogs = log.getLogs(LogLevel.ERROR);
	t.deepEqual(errorLogs, [
		`Error: Unusual oops!
    at connectSocket (script-0:21:11)
    at Object.fetch (script-0:41:19)
Caused by: TypeError: The value cannot be converted because it is not an integer.
    at connect (cloudflare:sockets:7:20)
    at connectSocket (script-0:8:20)
    at Object.fetch (script-0:41:19)`,
	]);

	// Check `fetch()` accepting HTML returns pretty-error page
	res = await fetch(url, { headers: { Accept: "text/html" } });
	t.is(res.status, 500);
	t.regex(res.headers.get("Content-Type") ?? "", /^text\/html/);

	// Check `fetch()` accepting text doesn't return pretty-error page
	res = await fetch(url, { headers: { Accept: "text/plain" } });
	t.is(res.status, 500);
	t.regex(res.headers.get("Content-Type") ?? "", /^text\/plain/);
	t.regex(await res.text(), /Unusual oops!/);

	// Check `fetch()` as `curl` doesn't return pretty-error page
	res = await fetch(url, { headers: { "User-Agent": "curl/0.0.0" } });
	t.is(res.status, 500);
	t.regex(res.headers.get("Content-Type") ?? "", /^text\/plain/);
	t.regex(await res.text(), /Unusual oops!/);

	// Check `dispatchFetch()` propagates exception
	await t.throwsAsync(mf.dispatchFetch(url), { message: "Unusual oops!" });
});
