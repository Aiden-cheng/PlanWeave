import { describe, expect, it } from "vitest";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";

const tokenA = "operator_token_a_abcdefghijklmnopqrstuvwxyz";
const tokenB = "operator_token_b_abcdefghijklmnopqrstuvwxyz";

describe("OperatorTokenRegistry", () => {
  it("authenticates transient bearer plaintext against configured digests", () => {
    const registry = new OperatorTokenRegistry([
      {
        operatorId: "operator-a",
        tokenSha256: hashOperatorToken(tokenA),
        projectIds: ["project-a"]
      }
    ]);
    expect(registry.authenticate(`Bearer ${tokenA}`)).toMatchObject({
      operatorId: "operator-a",
      projectIds: ["project-a"],
      serverAdmin: false
    });
    expect(registry.authenticate(`Bearer ${tokenB}`)).toBeUndefined();
  });

  it("rejects duplicate operator and token identities", () => {
    expect(
      () =>
        new OperatorTokenRegistry([
          {
            operatorId: "operator-a",
            tokenSha256: hashOperatorToken(tokenA),
            projectIds: []
          },
          {
            operatorId: "operator-a",
            tokenSha256: hashOperatorToken(tokenB),
            projectIds: []
          }
        ])
    ).toThrowError("operator_id_duplicate");
    expect(
      () =>
        new OperatorTokenRegistry([
          {
            operatorId: "operator-a",
            tokenSha256: hashOperatorToken(tokenA),
            projectIds: []
          },
          {
            operatorId: "operator-b",
            tokenSha256: hashOperatorToken(tokenA),
            projectIds: []
          }
        ])
    ).toThrowError("operator_token_duplicate");
  });
});
