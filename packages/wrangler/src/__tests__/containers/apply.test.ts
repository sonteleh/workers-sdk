import {
	getCloudflareContainerRegistry,
	OpenAPI,
	SchedulingPolicy,
	SecretAccessType,
} from "@cloudflare/containers-shared";
import { http, HttpResponse } from "msw";
import patchConsole from "patch-console";
import { apply } from "../../containers/deploy";
import { mockAccount } from "../cloudchamber/utils";
import { mockAccountId, mockApiToken } from "../helpers/mock-account-id";
import { mockCLIOutput } from "../helpers/mock-console";
import { useMockIsTTY } from "../helpers/mock-istty";
import { msw } from "../helpers/msw";
import { runInTempDir } from "../helpers/run-in-tmp";
import type { Config } from "../../config";
import type {
	Application,
	CreateApplicationRequest,
	ModifyApplicationRequestBody,
} from "@cloudflare/containers-shared";

function mockGetApplications(applications: Application[]) {
	msw.use(
		http.get(
			"*/applications",
			async () => {
				return HttpResponse.json(applications);
			},
			{ once: true }
		)
	);
}

function mockCreateApplication(
	response?: Partial<Application>,
	expected?: Partial<CreateApplicationRequest>
) {
	msw.use(
		http.post(
			"*/applications",
			async ({ request }) => {
				const body = (await request.json()) as CreateApplicationRequest;
				if (expected !== undefined) {
					expect(body).toMatchObject(expected);
				}
				expect(body).toHaveProperty("instances");
				return HttpResponse.json(response);
			},
			{ once: true }
		)
	);
}

function mockModifyApplication(
	expected?: Application
): Promise<ModifyApplicationRequestBody> {
	let response: (value: ModifyApplicationRequestBody) => void;
	const promise = new Promise<ModifyApplicationRequestBody>((res) => {
		response = res;
	});

	msw.use(
		http.patch(
			"*/applications/:id",
			async ({ request }) => {
				const json = await request.json();
				if (expected !== undefined) {
					expect(json).toEqual(expected);
				}

				expect((json as CreateApplicationRequest).name).toBeUndefined();
				response(json as ModifyApplicationRequestBody);
				return HttpResponse.json(json);
			},
			{ once: true }
		)
	);

	return promise;
}

const basicWranglerConfig = {
	name: "my-container",
	// // necessary to render the diff as toml
	configPath: "wrangler.toml",
	containers: [
		{
			name: "my-container-app",
			class_name: "DurableObjectClass",
			max_instances: 2,
			// this should be in the shape of wranglerConfig after the validation step
			configuration: { image: "docker.io/hello:hi" },
		},
	],
} as Config;

describe("containers apply", () => {
	/* eslint no-irregular-whitespace: ["error", { "skipTemplates": true }]
	   ---
	   Wrangler emits \u200a instead of "regular" whitespace in some cases. eslint doesn't like
	   this so we disable the warning when mixed whitespace is used in template strings.
	 */

	const { setIsTTY } = useMockIsTTY();
	const std = mockCLIOutput();

	mockAccountId();
	mockApiToken();
	beforeEach(mockAccount);
	runInTempDir();
	afterEach(() => {
		patchConsole(() => {});
		msw.resetHandlers();
	});

	beforeAll(() => {
		// populate OpenAPI.BASE with something so that msw gets a valid URL
		OpenAPI.BASE = "https://example.com/";
	});
	afterAll(() => {
		OpenAPI.BASE = "";
	});

	test("can apply a simple application", async () => {
		setIsTTY(false);

		mockGetApplications([]);
		mockCreateApplication({ id: "abc" });
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			basicWranglerConfig
		);

		expect(std.stderr).toMatchInlineSnapshot(`""`);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ NEW my-container-app
			│
			│   [[containers]]
			│   name = \\"my-container-app\\"
			│   max_instances = 2
			│   scheduling_policy = \\"default\\"
			│
			│   [containers.configuration]
			│   image = \\"docker.io/hello:hi\\"
			│   instance_type = \\"dev\\"
			│
			│   [containers.constraints]
			│   tier = 1
			│
			│
			│  SUCCESS  Created application my-container-app (Application ID: abc)
			│
			╰ Applied changes

			"
		`);
	});

	test("can apply a simple existing application", async () => {
		setIsTTY(false);

		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				max_instances: 3,
				instances: 0,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.DEFAULT,
				configuration: {
					image: "docker.io/hello:hi",
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 3,
				},
			},
		]);
		const applicationReqBodyPromise = mockModifyApplication();
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			basicWranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [[containers]]
			│   instances = 0
			│ - max_instances = 3
			│ + max_instances = 2
			│   name = \\"my-container-app\\"
			│
			│   [containers.constraints]
			│ - tier = 3
			│ + tier = 1
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		const app = await applicationReqBodyPromise;
		expect(app.constraints?.tier).toEqual(1);
		expect(app.max_instances).toEqual(2);
	});

	test("can apply a simple existing application and create other (max_instances)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			name: "my-container",
			configPath: "wrangler.toml",
			containers: [
				{
					name: "my-container-app",
					class_name: "DurableObjectClass",
					max_instances: 3,
					configuration: { image: "docker.io/hello:hi" },
				},
				{
					name: "my-container-app-2",
					max_instances: 3,
					class_name: "DurableObjectClass2",
					configuration: { image: "docker.io/hello:hi" },
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				max_instances: 4,
				instances: 3,
				created_at: new Date().toString(),
				account_id: "1",
				version: 1,
				scheduling_policy: SchedulingPolicy.DEFAULT,
				configuration: {
					image: "docker.io/hello:hi",
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		const res = mockModifyApplication();
		mockCreateApplication({ id: "abc" });
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		const body = await res;
		expect(body).not.toHaveProperty("instances");
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [[containers]]
			│   instances = 0
			│ - max_instances = 4
			│ + max_instances = 3
			│   name = \\"my-container-app\\"
			│
			├ NEW my-container-app-2
			│
			│   [[containers]]
			│   name = \\"my-container-app-2\\"
			│   max_instances = 3
			│   scheduling_policy = \\"default\\"
			│
			│   [containers.configuration]
			│   image = \\"docker.io/hello:hi\\"
			│   instance_type = \\"dev\\"
			│
			│   [containers.constraints]
			│   tier = 1
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			│
			│  SUCCESS  Created application my-container-app-2 (Application ID: abc)
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("can skip a simple existing application and create other", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			name: "my-container",
			configPath: "wrangler.toml",
			containers: [
				{
					name: "my-container-app",
					instances: 4,
					class_name: "DurableObjectClass",
					configuration: { image: "docker.io/hello:hi" },
					rollout_kind: "none",
				},
				{
					name: "my-container-app-2",
					instances: 1,
					class_name: "DurableObjectClass2",
					configuration: { image: "docker.io/other:app" },
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 3,
				created_at: new Date().toString(),
				account_id: "1",
				version: 1,
				scheduling_policy: SchedulingPolicy.DEFAULT,
				configuration: {
					image: "docker.io/hello:hi",
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		mockCreateApplication({ id: "abc" });
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);

		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [[containers]]
			│ - instances = 3
			│ + instances = 4
			│   name = \\"my-container-app\\"
			│ Skipping application rollout
			│
			├ NEW my-container-app-2
			│
			│   [[containers]]
			│   name = \\"my-container-app-2\\"
			│   instances = 1
			│   scheduling_policy = \\"default\\"
			│
			│   [containers.configuration]
			│   image = \\"docker.io/other:app\\"
			│   instance_type = \\"dev\\"
			│
			│   [containers.constraints]
			│   tier = 1
			│
			│
			│  SUCCESS  Created application my-container-app-2 (Application ID: abc)
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("can apply a simple existing application and create other", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			name: "my-container",
			configPath: "wrangler.toml",
			containers: [
				{
					name: "my-container-app",
					instances: 4,
					class_name: "DurableObjectClass",
					configuration: { age: "docker.io/hello:hi" },
				},
				{
					name: "my-container-app-2",
					instances: 1,
					class_name: "DurableObjectClass2",
					configuration: { image: "docker.io/other:app" },
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 3,
				created_at: new Date().toString(),
				account_id: "1",
				version: 1,
				scheduling_policy: SchedulingPolicy.DEFAULT,
				configuration: {
					image: "docker.io/hello:hi",
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		const res = mockModifyApplication();
		mockCreateApplication({ id: "abc" });
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		await res;
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [[containers]]
			│ - instances = 3
			│ + instances = 4
			│   name = \\"my-container-app\\"
			│
			│   [containers.configuration]
			│   ...
			│   instance_type = \\"dev\\"
			│ + age = \\"docker.io/hello:hi\\"
			│
			│   [containers.constraints]
			│   ...
			│
			├ NEW my-container-app-2
			│
			│   [[containers]]
			│   name = \\"my-container-app-2\\"
			│   instances = 1
			│   scheduling_policy = \\"default\\"
			│
			│   [containers.configuration]
			│   image = \\"docker.io/other:app\\"
			│   instance_type = \\"dev\\"
			│
			│   [containers.constraints]
			│   tier = 1
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			│
			│  SUCCESS  Created application my-container-app-2 (Application ID: abc)
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("can apply an application, and there is no changes (retrocompatibility with regional scheduling policy)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			name: "my-container",
			configPath: "wrangler.toml",
			containers: [
				{
					class_name: "DurableObjectClass",
					name: "my-container-app",
					instances: 3,
					configuration: {
						image: "docker.io/hello:hi",
						labels: [
							{
								name: "name",
								value: "value",
							},
							{
								name: "name-2",
								value: "value-2",
							},
						],
						secrets: [
							{
								name: "MY_SECRET",
								type: SecretAccessType.ENV,
								secret: "SECRET_NAME",
							},
							{
								name: "MY_SECRET_1",
								type: SecretAccessType.ENV,
								secret: "SECRET_NAME_1",
							},
							{
								name: "MY_SECRET_2",
								type: SecretAccessType.ENV,
								secret: "SECRET_NAME_2",
							},
						],
					},
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 3,
				version: 1,
				created_at: new Date().toString(),
				account_id: "1",
				scheduling_policy: SchedulingPolicy.DEFAULT,
				configuration: {
					image: "docker.io/hello:hi",
					labels: [
						{
							name: "name",
							value: "value",
						},
						{
							name: "name-2",
							value: "value-2",
						},
					],
					secrets: [
						{
							name: "MY_SECRET",
							type: SecretAccessType.ENV,
							secret: "SECRET_NAME",
						},
						{
							name: "MY_SECRET_1",
							type: SecretAccessType.ENV,
							secret: "SECRET_NAME_1",
						},
						{
							name: "MY_SECRET_2",
							type: SecretAccessType.ENV,
							secret: "SECRET_NAME_2",
						},
					],
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},

				constraints: {
					tier: 1,
				},
			},
		]);
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ no changes my-container-app
			│
			╰ No changes to be made

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("can apply an application, and there is no changes (two applications)", async () => {
		setIsTTY(false);
		const app = {
			name: "my-container-app",
			instances: 3,
			class_name: "DurableObjectClass",
			image: "./Dockerfile",
			configuration: {
				labels: [
					{
						name: "name",
						value: "value",
					},
					{
						name: "name-2",
						value: "value-2",
					},
				],
				secrets: [
					{
						name: "MY_SECRET",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME",
					},
					{
						name: "MY_SECRET_1",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME_1",
					},
					{
						name: "MY_SECRET_2",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME_2",
					},
				],
			},
		};
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [app, { ...app, name: "my-container-app-2" }],
		} as Config;

		const completeApp = {
			id: "abc",
			name: "my-container-app",
			instances: 3,
			created_at: new Date().toString(),
			class_name: "DurableObjectClass",
			account_id: "1",
			scheduling_policy: SchedulingPolicy.DEFAULT,
			configuration: {
				image: "./Dockerfile",
				labels: [
					{
						name: "name",
						value: "value",
					},
					{
						name: "name-2",
						value: "value-2",
					},
				],
				secrets: [
					{
						name: "MY_SECRET",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME",
					},
					{
						name: "MY_SECRET_1",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME_1",
					},
					{
						name: "MY_SECRET_2",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME_2",
					},
				],
				disk: {
					size: "2GB",
					size_mb: 2000,
				},
				vcpu: 0.0625,
				memory: "256MB",
				memory_mib: 256,
			},

			constraints: {
				tier: 1,
			},
		};

		mockGetApplications([
			{ ...completeApp, version: 1 },
			{ ...completeApp, version: 1, name: "my-container-app-2", id: "abc2" },
		]);
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ no changes my-container-app
			│
			├ no changes my-container-app-2
			│
			╰ No changes to be made

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("can apply an application, and there is no changes", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [
				{
					class_name: "DurableObjectClass",
					name: "my-container-app",
					instances: 3,
					image: "docker.io/hello:hi",
					configuration: {
						labels: [
							{
								name: "name",
								value: "value",
							},
							{
								name: "name-2",
								value: "value-2",
							},
						],
						secrets: [
							{
								name: "MY_SECRET",
								type: SecretAccessType.ENV,
								secret: "SECRET_NAME",
							},
							{
								name: "MY_SECRET_1",
								type: SecretAccessType.ENV,
								secret: "SECRET_NAME_1",
							},
							{
								name: "MY_SECRET_2",
								type: SecretAccessType.ENV,
								secret: "SECRET_NAME_2",
							},
						],
					},
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 3,
				version: 1,
				created_at: new Date().toString(),
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					labels: [
						{
							name: "name",
							value: "value",
						},
						{
							name: "name-2",
							value: "value-2",
						},
					],
					secrets: [
						{
							name: "MY_SECRET",
							type: SecretAccessType.ENV,
							secret: "SECRET_NAME",
						},
						{
							name: "MY_SECRET_1",
							type: SecretAccessType.ENV,
							secret: "SECRET_NAME_1",
						},
						{
							name: "MY_SECRET_2",
							type: SecretAccessType.ENV,
							secret: "SECRET_NAME_2",
						},
					],
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},

				constraints: {
					tier: 1,
				},
			},
		]);
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ no changes my-container-app
			│
			╰ No changes to be made

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("can apply an application, and there is no changes (two applications)", async () => {
		setIsTTY(false);
		const app = {
			name: "my-container-app",
			instances: 3,
			class_name: "DurableObjectClass",
			image: "./Dockerfile",
			configuration: {
				labels: [
					{
						name: "name",
						value: "value",
					},
					{
						name: "name-2",
						value: "value-2",
					},
				],
				secrets: [
					{
						name: "MY_SECRET",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME",
					},
					{
						name: "MY_SECRET_1",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME_1",
					},
					{
						name: "MY_SECRET_2",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME_2",
					},
				],
			},
		};
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [app, { ...app, name: "my-container-app-2" }],
		} as Config;

		const completeApp = {
			id: "abc",
			name: "my-container-app",
			instances: 3,
			created_at: new Date().toString(),
			class_name: "DurableObjectClass",
			account_id: "1",
			scheduling_policy: SchedulingPolicy.REGIONAL,
			configuration: {
				image: "./Dockerfile",
				labels: [
					{
						name: "name",
						value: "value",
					},
					{
						name: "name-2",
						value: "value-2",
					},
				],
				secrets: [
					{
						name: "MY_SECRET",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME",
					},
					{
						name: "MY_SECRET_1",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME_1",
					},
					{
						name: "MY_SECRET_2",
						type: SecretAccessType.ENV,
						secret: "SECRET_NAME_2",
					},
				],
				disk: {
					size: "2GB",
					size_mb: 2000,
				},
				vcpu: 0.0625,
				memory: "256MB",
				memory_mib: 256,
			},

			constraints: {
				tier: 1,
			},
		};

		mockGetApplications([
			{ ...completeApp, version: 1 },
			{ ...completeApp, version: 1, name: "my-container-app-2", id: "abc2" },
		]);
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ no changes my-container-app
			│
			├ no changes my-container-app-2
			│
			╰ No changes to be made

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("can enable observability logs (top-level field)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			observability: { enabled: true },
			containers: [
				{
					name: "my-container-app",
					class_name: "DurableObjectClass",
					instances: 1,
					image: "docker.io/hello:hi",
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 1,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		const applicationReqBodyPromise = mockModifyApplication();
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [containers.configuration]
			│   ...
			│   instance_type = \\"dev\\"
			│
			│ + [containers.configuration.observability.logs]
			│ + enabled = true
			│
			│   [containers.constraints]
			│   ...
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		const app = await applicationReqBodyPromise;
		expect(app.constraints?.tier).toEqual(1);
		expect(app.instances).toEqual(1);
	});

	test("can enable observability logs (logs field)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			observability: { logs: { enabled: true } },
			containers: [
				{
					name: "my-container-app",
					class_name: "DurableObjectClass",
					instances: 1,
					image: "docker.io/hello:hi",
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 1,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		const applicationReqBodyPromise = mockModifyApplication();
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [containers.configuration]
			│   ...
			│   instance_type = \\"dev\\"
			│
			│ + [containers.configuration.observability.logs]
			│ + enabled = true
			│
			│   [containers.constraints]
			│   ...
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		const app = await applicationReqBodyPromise;
		expect(app.constraints?.tier).toEqual(1);
		expect(app.instances).toEqual(1);
	});

	test("can disable observability logs (top-level field)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			observability: { enabled: false },
			containers: [
				{
					name: "my-container-app",
					class_name: "DurableObjectClass",
					instances: 1,
					image: "docker.io/hello:hi",
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 1,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					observability: {
						logs: {
							enabled: true,
						},
					},
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		const applicationReqBodyPromise = mockModifyApplication();
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [containers.configuration.observability.logs]
			│ - enabled = true
			│ + enabled = false
			│
			│   [containers.constraints]
			│   ...
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		const app = await applicationReqBodyPromise;
		expect(app.constraints?.tier).toEqual(1);
		expect(app.instances).toEqual(1);
	});

	test("can disable observability logs (logs field)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			observability: { logs: { enabled: false } },
			containers: [
				{
					name: "my-container-app",
					class_name: "DurableObjectClass",
					instances: 1,
					image: "docker.io/hello:hi",
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 1,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					observability: {
						logs: {
							enabled: true,
						},
					},
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		const applicationReqBodyPromise = mockModifyApplication();
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [containers.configuration.observability.logs]
			│ - enabled = true
			│ + enabled = false
			│
			│   [containers.constraints]
			│   ...
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		const app = await applicationReqBodyPromise;
		expect(app.constraints?.tier).toEqual(1);
		expect(app.instances).toEqual(1);
	});

	test("can disable observability logs (absent field)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [
				{
					name: "my-container-app",
					class_name: "DurableObjectClass",
					instances: 1,
					image: "docker.io/hello:hi",
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 1,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					observability: {
						logs: {
							enabled: true,
						},
					},
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		const applicationReqBodyPromise = mockModifyApplication();
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [containers.configuration.observability.logs]
			│ - enabled = true
			│ + enabled = false
			│
			│   [containers.constraints]
			│   ...
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		const app = await applicationReqBodyPromise;
		expect(app.constraints?.tier).toEqual(1);
		expect(app.instances).toEqual(1);
	});

	test("ignores deprecated observability.logging", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [
				{
					name: "my-container-app",
					class_name: "DurableObjectClass",
					instances: 1,
					image: "docker.io/hello:hi",
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 1,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					observability: {
						logs: {
							enabled: true,
						},
						logging: {
							enabled: true,
						},
					},
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		const applicationReqBodyPromise = mockModifyApplication();
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [containers.configuration.observability.logs]
			│ - enabled = true
			│ + enabled = false
			│
			│   [containers.constraints]
			│   ...
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		const app = await applicationReqBodyPromise;
		expect(app.constraints?.tier).toEqual(1);
		expect(app.instances).toEqual(1);
	});

	test("keeps observability logs enabled", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			observability: { enabled: true },
			containers: [
				{
					name: "my-container-app",
					class_name: "DurableObjectClass",
					instances: 1,
					image: "docker.io/hello:hi",
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 1,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					observability: {
						logs: {
							enabled: true,
						},
						logging: {
							enabled: true,
						},
					},
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ no changes my-container-app
			│
			╰ No changes to be made

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("keeps observability logs disabled (undefined in the app)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [
				{
					name: "my-container-app",
					class_name: "DurableObjectClass",
					instances: 1,
					image: "docker.io/hello:hi",
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 1,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ no changes my-container-app
			│
			╰ No changes to be made

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("keeps observability logs disabled (false in the app)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [
				{
					name: "my-container-app",
					class_name: "DurableObjectClass",
					instances: 1,
					image: "docker.io/hello:hi",
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 1,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					observability: {
						logs: {
							enabled: false,
						},
						logging: {
							enabled: false,
						},
					},
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 1,
				},
			},
		]);
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ no changes my-container-app
			│
			╰ No changes to be made

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("can apply a simple application (instance type)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [
				{
					name: "my-container-app",
					instances: 3,
					class_name: "DurableObjectClass",
					instance_type: "dev",
					image: "docker.io/hello:hi",
					constraints: {
						tier: 2,
					},
				},
			],
		} as Config;
		mockGetApplications([]);
		mockCreateApplication({ id: "abc" });
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ NEW my-container-app
			│
			│   [[containers]]
			│   name = \\"my-container-app\\"
			│   instances = 3
			│   scheduling_policy = \\"default\\"
			│
			│   [containers.constraints]
			│   tier = 2
			│
			│   [containers.configuration]
			│   instance_type = \\"dev\\"
			│
			│
			│  SUCCESS  Created application my-container-app (Application ID: abc)
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
	});

	test("can apply a simple existing application (instance type)", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [
				{
					name: "my-container-app",
					instances: 4,
					class_name: "DurableObjectClass",
					instance_type: "standard",
					image: "docker.io/hello:hi",
					constraints: {
						tier: 2,
					},
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 3,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 3,
				},
			},
		]);
		const applicationReqBodyPromise = mockModifyApplication();
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [[containers]]
			│ - instances = 3
			│ + instances = 4
			│   name = \\"my-container-app\\"
			│
			│   [containers.configuration]
			│   image = \\"docker.io/hello:hi\\"
			│ - instance_type = \\"dev\\"
			│ + instance_type = \\"standard\\"
			│
			│   [containers.constraints]
			│   ...
			│ - tier = 3
			│ + tier = 2
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		const app = await applicationReqBodyPromise;
		expect(app.configuration?.instance_type).toEqual("standard");
	});

	test("falls back on dev instance type when instance type is absent", async () => {
		setIsTTY(false);
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [
				{
					name: "my-container-app",
					instances: 4,
					class_name: "DurableObjectClass",
					image: "docker.io/hello:hi",
					constraints: {
						tier: 2,
					},
				},
			],
		} as Config;
		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 3,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: "docker.io/hello:hi",
					disk: {
						size: "4GB",
						size_mb: 4000,
					},
					vcpu: 0.25,
					memory: "1024MB",
					memory_mib: 1024,
				},
				constraints: {
					tier: 3,
				},
			},
		]);
		const applicationReqBodyPromise = mockModifyApplication();
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [[containers]]
			│ - instances = 3
			│ + instances = 4
			│   name = \\"my-container-app\\"
			│
			│   [containers.configuration]
			│   image = \\"docker.io/hello:hi\\"
			│ - instance_type = \\"basic\\"
			│ + instance_type = \\"dev\\"
			│
			│   [containers.constraints]
			│   ...
			│ - tier = 3
			│ + tier = 2
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		const app = await applicationReqBodyPromise;
		expect(app.configuration?.instance_type).toEqual("dev");
	});

	test("expands image names from managed registry when creating an application", async () => {
		setIsTTY(false);
		const registry = getCloudflareContainerRegistry();
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [
				{
					name: "my-container-app",
					instances: 3,
					class_name: "DurableObjectClass",
					configuration: { image: `${registry}/hello:1.0` },
					constraints: {
						tier: 2,
					},
				},
			],
		} as Config;

		mockGetApplications([]);
		mockCreateApplication(
			{ id: "abc" },
			{
				configuration: {
					image: `${registry}/some-account-id/hello:1.0`,
				},
			}
		);

		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ NEW my-container-app
			│
			│   [[containers]]
			│   name = \\"my-container-app\\"
			│   instances = 3
			│   scheduling_policy = \\"default\\"
			│
			│   [containers.configuration]
			│   image = \\"registry.cloudflare.com/some-account-id/hello:1.0\\"
			│   instance_type = \\"dev\\"
			│
			│   [containers.constraints]
			│   tier = 2
			│
			│
			│  SUCCESS  Created application my-container-app (Application ID: abc)
			│
			╰ Applied changes

			"
		`);
	});

	test("expands image names from managed registry when modifying an application", async () => {
		setIsTTY(false);
		const registry = getCloudflareContainerRegistry();
		const wranglerConfig = {
			configPath: "wrangler.toml",
			name: "my-container",
			containers: [
				{
					name: "my-container-app",
					instances: 3,
					class_name: "DurableObjectClass",
					image: `${registry}/hello:1.0`,
					instance_type: "standard",
					constraints: {
						tier: 2,
					},
				},
			],
		} as Config;

		mockGetApplications([
			{
				id: "abc",
				name: "my-container-app",
				instances: 3,
				created_at: new Date().toString(),
				version: 1,
				account_id: "1",
				scheduling_policy: SchedulingPolicy.REGIONAL,
				configuration: {
					image: `${registry}/some-account-id/hello:1.0`,
					disk: {
						size: "2GB",
						size_mb: 2000,
					},
					vcpu: 0.0625,
					memory: "256MB",
					memory_mib: 256,
				},
				constraints: {
					tier: 3,
				},
			},
		]);

		const applicationReqBodyPromise = mockModifyApplication();
		await apply(
			{ skipDefaults: false, imageUpdateRequired: false },
			wranglerConfig
		);
		expect(std.stdout).toMatchInlineSnapshot(`
			"╭ Deploy a container application deploy changes to your application
			│
			│ Container application changes
			│
			├ EDIT my-container-app
			│
			│   [containers.configuration]
			│   image = \\"${registry}/some-account-id/hello:1.0\\"
			│ - instance_type = \\"dev\\"
			│ + instance_type = \\"standard\\"
			│
			│   [containers.constraints]
			│   ...
			│ - tier = 3
			│ + tier = 2
			│
			│
			│  SUCCESS  Modified application my-container-app
			│
			╰ Applied changes

			"
		`);
		expect(std.stderr).toMatchInlineSnapshot(`""`);
		const app = await applicationReqBodyPromise;
		expect(app.configuration?.instance_type).toEqual("standard");
	});
});
