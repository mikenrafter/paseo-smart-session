export interface DaemonPasswordOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

export function resolveDaemonPassword(options?: DaemonPasswordOptions): Promise<string | undefined>;
