/**
 * Operator-control IPC names are loadable by the sandboxed preload process.
 * Keep this module free of runtime distributed-protocol imports.
 */
export const operatorControlInvokeChannels = {
  getStatus: "planweave-operator:getStatus",
  upsertProfile: "planweave-operator:upsertProfile",
  removeProfile: "planweave-operator:removeProfile",
  setActiveProfile: "planweave-operator:setActiveProfile",
  clearActiveProfile: "planweave-operator:clearActiveProfile",
  importCredential: "planweave-operator:importCredential",
  clearCredential: "planweave-operator:clearCredential",
  listHosts: "planweave-operator:listHosts",
  copyHostBootstrapHandoff: "planweave-operator:copyHostBootstrapHandoff",
  revokeHost: "planweave-operator:revokeHost"
} as const;

export const operatorControlStatusChangedChannel = "planweave-operator:statusChanged";
