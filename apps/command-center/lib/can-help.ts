import { CanHelpStore } from "@aac/quoting";
import { getRedis } from "./redis";

export function getCanHelpStore(): CanHelpStore {
  return new CanHelpStore(getRedis());
}
