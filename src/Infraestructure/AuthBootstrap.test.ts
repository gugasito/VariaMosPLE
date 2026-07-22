import { captureAuthTokenFromUrl } from "./AuthBootstrap";

describe("captureAuthTokenFromUrl", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/#/model");
  });

  it("stores the returned token before authentication starts and removes it from the URL", () => {
    window.history.replaceState({}, "", "/?authToken=token-for-local-client#/model");

    captureAuthTokenFromUrl();

    expect(localStorage.getItem("authToken")).toBe("token-for-local-client");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/model");
  });

  it("does not replace an existing token when the URL has no callback token", () => {
    localStorage.setItem("authToken", "existing-token");

    captureAuthTokenFromUrl();

    expect(localStorage.getItem("authToken")).toBe("existing-token");
  });
});
