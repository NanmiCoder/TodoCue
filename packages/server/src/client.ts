import { TodoCueClient as PortableClient } from "@todocue/client";
import type { ConnectionInfo } from "@todocue/shared";
import { readJsonFile, resolveHome, runtimePaths } from "./config.js";
export type { ClientOptions, RequestOptions } from "@todocue/client";
export class TodoCueClient extends PortableClient {
  static fromHome(home?: string): TodoCueClient | null {
    const info = readJsonFile<ConnectionInfo>(runtimePaths(resolveHome(home)).connection);
    return info?.baseUrl && info.token ? new TodoCueClient({ baseUrl: info.baseUrl, token: info.token }) : null;
  }
}
