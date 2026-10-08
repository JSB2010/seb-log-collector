// Index the exposed filter combinations for each supported catalog sort.
import { readFile, writeFile } from "node:fs/promises";
const entries = JSON.parse(await readFile("infra/indexes.json", "utf8"));
for (const [key, v] of Object.entries(entries))
  if (v.collection === "devices" && v.fields.some((f) => f.field_path === "id"))
    delete entries[key];
// Optional API-only collector/source filters are applied to each ordered page,
// avoiding hundreds of rarely used array-prefix index combinations.
for (const [key, v] of Object.entries(entries))
  if (
    v.collection === "logs" &&
    v.fields.some((f) =>
      ["metadata.collectorVersion", "sourceUser"].includes(f.field_path),
    )
  )
    delete entries[key];
const fields = [
  "searchTokens",
  "metadata.macOSVersion",
  "metadata.sebVersion",
  "deviceId",
];
const field = (name, order = "ASCENDING") =>
  name === "searchTokens"
    ? { field_path: name, array_config: "CONTAINS" }
    : { field_path: name, order };
const add = (collection, names, order, direction) => {
  const key = `${collection}-${names.join("-").replaceAll(".", "_")}-${order}-${direction}`;
  const value = {
    collection,
    fields: [...names.map((n) => field(n)), field(order, direction)],
  };
  if (
    !Object.values(entries).some(
      (v) => JSON.stringify(v) === JSON.stringify(value),
    )
  )
    entries[key] = value;
};
for (let mask = 1; mask < 1 << fields.length; mask++)
  for (const order of ["acceptedAt", "logStartedAt"])
    for (const direction of ["ASCENDING", "DESCENDING"])
      add(
        "logs",
        fields.filter((_, i) => mask & (1 << i)),
        order,
        direction,
      );
for (const direction of ["ASCENDING", "DESCENDING"])
  add("sessionLinks", ["instance", "session"], "logStartedAt", direction);
add("sessionLinks", ["instance", "session"], "acceptedAt", "ASCENDING");
add("devices", ["enrollmentGroupId"], "id", "ASCENDING");
add("devices", ["enrollmentGroupId", "state"], "id", "ASCENDING");
add("deviceCommands", ["deviceId"], "createdAt", "DESCENDING");
add("enrollmentBatches", ["state"], "createdAt", "DESCENDING");
add("enrollmentBatches", ["state"], "id", "ASCENDING");
await writeFile("infra/indexes.json", JSON.stringify(entries, null, 2) + "\n");
console.log(`${Object.keys(entries).length} catalog indexes`);
