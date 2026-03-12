import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ENUMS = require("./enums.cjs");

const PROFILES = ENUMS?.CANodeProfile;
const ATTR_TYPES = ENUMS?.CAAttributeType;

export function profileId(key) {
  const id = PROFILES?.[key];
  if (typeof id !== "number") throw new Error(`Unknown CANodeProfile key: ${key}`);
  return id;
}

export function attributeTypeId(key) {
  const alias = {
    // Older code used this name; in enums.js it is called IdentificationMode (170). fileciteturn1file0
    CAAttributeTypeIdentification: "CAAttributeTypeIdentificationMode",
  };
  const resolvedKey = alias[key] ?? key;
  const id = ATTR_TYPES?.[resolvedKey];
  if (typeof id !== "number") throw new Error(`Unknown CAAttributeType key: ${key}`);
  return id;
}

