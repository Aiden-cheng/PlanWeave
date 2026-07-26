type HostBootstrapCommandInput = {
  configPath: string;
  enrollmentCode: string;
};

export function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildAgentHostBootstrapCommand({
  configPath,
  enrollmentCode
}: HostBootstrapCommandInput): string {
  const config = quotePosixShellArgument(configPath.trim());
  const code = quotePosixShellArgument(enrollmentCode);
  return [
    `planweave-agent-host preflight --config ${config}`,
    `planweave-agent-host enroll --config ${config} --code ${code}`,
    `planweave-agent-host run --config ${config}`
  ].join("\n");
}
