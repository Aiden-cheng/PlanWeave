import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n";
import { formatAgentEndpointFleetCatalogError } from "./formatAgentEndpointFleetCatalogError";

describe("formatAgentEndpointFleetCatalogError", () => {
  it("does not route fleet credential failures to People / Workspace connection copy", () => {
    const t = createTranslator("en");
    const message = formatAgentEndpointFleetCatalogError("operator_credential_missing", t);
    expect(message).toContain("Settings → Server");
    expect(message).not.toMatch(/People/i);
    expect(message).not.toMatch(/connect.*workspace/i);
  });
});
