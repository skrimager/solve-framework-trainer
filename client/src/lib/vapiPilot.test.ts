import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  VAPI_PILOT_SCENARIO_SLUG,
  isVapiPilotActive,
  queryParamOn,
  vapiPilotConfigFromEnv,
} from "./vapiPilot";

const CONFIG = { publicKey: "pk_test", assistantId: "asst_test" };

describe("vapiPilotConfigFromEnv", () => {
  test("returns config only when both values are present", () => {
    assert.deepEqual(
      vapiPilotConfigFromEnv({ VITE_VAPI_PUBLIC_KEY: "pk", VITE_VAPI_ASSISTANT_ID: "asst" }),
      { publicKey: "pk", assistantId: "asst" },
    );
    assert.equal(vapiPilotConfigFromEnv({ VITE_VAPI_PUBLIC_KEY: "pk" }), null);
    assert.equal(vapiPilotConfigFromEnv({ VITE_VAPI_ASSISTANT_ID: "asst" }), null);
    assert.equal(vapiPilotConfigFromEnv({}), null);
  });

  test("whitespace-only values count as missing", () => {
    assert.equal(vapiPilotConfigFromEnv({ VITE_VAPI_PUBLIC_KEY: "  ", VITE_VAPI_ASSISTANT_ID: "asst" }), null);
  });

  test("values are trimmed", () => {
    assert.deepEqual(vapiPilotConfigFromEnv({ VITE_VAPI_PUBLIC_KEY: " pk ", VITE_VAPI_ASSISTANT_ID: " asst " }), {
      publicKey: "pk",
      assistantId: "asst",
    });
  });
});

describe("queryParamOn", () => {
  test("accepts ?vapi=1, ?vapi=true and a bare ?vapi", () => {
    assert.equal(queryParamOn("?vapi=1"), true);
    assert.equal(queryParamOn("?vapi=true"), true);
    assert.equal(queryParamOn("?vapi"), true);
    assert.equal(queryParamOn("vapi=1"), true);
  });

  test("an explicitly falsy value does not opt in", () => {
    assert.equal(queryParamOn("?vapi=0"), false);
    assert.equal(queryParamOn("?vapi=false"), false);
  });

  test("absence and other params do not opt in", () => {
    assert.equal(queryParamOn(""), false);
    assert.equal(queryParamOn(undefined), false);
    assert.equal(queryParamOn("?other=1"), false);
    assert.equal(queryParamOn("?vapipilot=1"), false);
  });
});

describe("isVapiPilotActive", () => {
  test("on for the pilot scenario with the env flag set and keys configured", () => {
    assert.equal(
      isVapiPilotActive({ scenarioSlug: VAPI_PILOT_SCENARIO_SLUG, envFlag: "1", config: CONFIG }),
      true,
    );
  });

  test("the query param alone is enough when the env flag is off", () => {
    assert.equal(
      isVapiPilotActive({
        scenarioSlug: VAPI_PILOT_SCENARIO_SLUG,
        envFlag: "0",
        search: "?vapi=1",
        config: CONFIG,
      }),
      true,
    );
  });

  // The safety property the whole pilot rests on: no other scenario can be
  // routed through Vapi, even with the flag on, the param set and keys present.
  test("OFF for every other scenario no matter how the flag is set", () => {
    for (const slug of ["auto-sales-first-time-buyer", "leadership-missed-targets", "", undefined, null]) {
      assert.equal(
        isVapiPilotActive({ scenarioSlug: slug, envFlag: "true", search: "?vapi=1", config: CONFIG }),
        false,
        `pilot must stay off for slug: ${String(slug)}`,
      );
    }
  });

  test("OFF while the scenario is still loading", () => {
    assert.equal(isVapiPilotActive({ envFlag: "1", config: CONFIG }), false);
  });

  test("OFF with no flag and no query param", () => {
    assert.equal(isVapiPilotActive({ scenarioSlug: VAPI_PILOT_SCENARIO_SLUG, config: CONFIG }), false);
  });

  // A half-configured environment must fall back to the existing path rather
  // than entering the pilot and failing when the call is dialled.
  test("OFF when keys are missing", () => {
    assert.equal(isVapiPilotActive({ scenarioSlug: VAPI_PILOT_SCENARIO_SLUG, envFlag: "1", config: null }), false);
    assert.equal(
      isVapiPilotActive({ scenarioSlug: VAPI_PILOT_SCENARIO_SLUG, envFlag: "1", config: { publicKey: "pk" } }),
      false,
    );
    assert.equal(
      isVapiPilotActive({ scenarioSlug: VAPI_PILOT_SCENARIO_SLUG, envFlag: "1", config: { assistantId: "asst" } }),
      false,
    );
  });

  // Vite inlines env vars as strings, so the literal "false" must not read as on.
  test("string-typed falsy env flag values do not enable the pilot", () => {
    for (const value of ["false", "0", "no", "off", "", "  ", undefined, null, false, 0]) {
      assert.equal(
        isVapiPilotActive({ scenarioSlug: VAPI_PILOT_SCENARIO_SLUG, envFlag: value, config: CONFIG }),
        false,
        `env flag ${JSON.stringify(value)} must not enable the pilot`,
      );
    }
  });

  test("accepts the usual truthy spellings of the env flag", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
      assert.equal(
        isVapiPilotActive({ scenarioSlug: VAPI_PILOT_SCENARIO_SLUG, envFlag: value, config: CONFIG }),
        true,
        `env flag ${JSON.stringify(value)} should enable the pilot`,
      );
    }
  });
});
