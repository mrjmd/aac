import { PeopleStore } from "@aac/items";
import { getRedis } from "./redis";

export function getPeopleStore(): PeopleStore {
  return new PeopleStore(getRedis());
}
