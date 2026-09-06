export interface FakeSeedUser {
  readonly username: string;
  readonly password: string;
  readonly permissions: Record<string, string[]>;
  readonly virtualFolders?: { name: string; virtualPath: string }[];
}

export interface FakeSeed {
  readonly users: FakeSeedUser[];
  readonly folders?: { name: string }[];
  /** username -> virtual path -> utf8 content. The key "@<folderName>" seeds a shared folder. */
  readonly files?: Record<string, Record<string, string>>;
  readonly tokenTtlMs?: number;
  readonly now?: () => Date;
}
