import { describe, expect, it } from "vitest";
import {
  APPROVE_FLAG,
  COLLECTION_FLAG,
  DEPTH_ENV,
  HOST_CONFIG_ENV,
  parseDepth,
  resolveExtensionConfig,
} from "../src/extension/config.js";

function flags(values: Record<string, string | boolean | undefined>) {
  return { getFlag: (name: string) => values[name] };
}

describe("agent session extension config", () => {
  it("prefers the host JSON contract over terminal flags", () => {
    const config = resolveExtensionConfig(
      flags({ [COLLECTION_FLAG]: "/ignored", [APPROVE_FLAG]: true }),
      {
        [HOST_CONFIG_ENV]: JSON.stringify({
          collectionRoot: "/host/agents",
          approveProjectResources: false,
          discovery: { maxAgents: 25 },
          controller: {
            executable: { command: "/host/pi", argvPrefix: ["cli.js"] },
            extensionPaths: ["/host/extensions/a.js"],
            limits: { maxChildren: 2 },
          },
        }),
        [DEPTH_ENV]: "0",
      },
    );

    expect(config).toMatchObject({
      source: "host",
      sessions: {
        collectionRoot: "/host/agents",
        approveProjectResources: false,
        depth: 0,
        discovery: { maxAgents: 25 },
        controller: {
          executable: { command: "/host/pi", argvPrefix: ["cli.js"] },
          extensionPaths: ["/host/extensions/a.js"],
          limits: { maxChildren: 2 },
        },
      },
    });
  });

  it("uses terminal collection and approval flags when no host contract exists", () => {
    expect(
      resolveExtensionConfig(flags({ [COLLECTION_FLAG]: "/terminal/agents", [APPROVE_FLAG]: true }), {}),
    ).toEqual({
      source: "terminal",
      sessions: {
        collectionRoot: "/terminal/agents",
        approveProjectResources: true,
        depth: 0,
      },
    });
  });

  it("keeps no-collection defaults non-launching", () => {
    expect(resolveExtensionConfig(flags({}), {})).toEqual({
      source: "defaults",
      sessions: { collectionRoot: undefined, approveProjectResources: false, depth: 0 },
    });
  });

  it("rejects malformed, unknown, or mistyped host fields", () => {
    expect(() => resolveExtensionConfig(flags({}), { [HOST_CONFIG_ENV]: "{" })).toThrow("valid JSON");
    expect(() =>
      resolveExtensionConfig(flags({}), { [HOST_CONFIG_ENV]: JSON.stringify({ collectionRoot: "/x", typo: true }) }),
    ).toThrow("unknown field");
    expect(() =>
      resolveExtensionConfig(flags({}), { [HOST_CONFIG_ENV]: JSON.stringify({ approveProjectResources: "yes" }) }),
    ).toThrow("boolean");
    expect(() =>
      resolveExtensionConfig(flags({}), { [HOST_CONFIG_ENV]: JSON.stringify({ controller: { limits: { maxChildren: 1.5 } } }) }),
    ).toThrow("integer");
  });

  it("parses only a bounded non-negative launch depth", () => {
    expect(parseDepth(undefined)).toBe(0);
    expect(parseDepth("0")).toBe(0);
    expect(parseDepth("1")).toBe(1);
    expect(() => parseDepth("-1")).toThrow(DEPTH_ENV);
    expect(() => parseDepth("1.5")).toThrow(DEPTH_ENV);
    expect(() => parseDepth("33")).toThrow(DEPTH_ENV);
  });
});
