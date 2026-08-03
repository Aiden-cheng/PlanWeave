import { createTransportAdmissionPolicyForMode } from "../../insecureTransport.js";

export const loopbackHttpTransportAdmission =
  createTransportAdmissionPolicyForMode("loopback_http");
export const directHttpsTransportAdmission = createTransportAdmissionPolicyForMode("direct_https");
