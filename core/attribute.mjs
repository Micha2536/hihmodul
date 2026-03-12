export default class Attribute {
  constructor(
    id,
    nodeID,
    instance,
    min,
    max,
    currentValue,
    targetValue,
    lastValue,
    unit,
    stepValue,
    editable,
    type,
    data = "",
    deviceRef = null
  ) {
    this.id = id;
    this.node_id = nodeID;
    this.instance = instance;
    this.minimum = min;
    this.maximum = max;
    this.current_value = currentValue;
    this.target_value = targetValue;
    this.last_value = lastValue;
    this.unit = unit;
    this.step_value = stepValue;
    this.editable = editable;
    this.type = type;

    this.state = 1;
    this.last_changed = 12345555;
    this.changed_by = 1;
    this.changed_by_id = 0;
    this.based_on = 1;

    // Never store routing refs in the homee 'data' field.
    // If the 13th arg is an object, treat it as deviceRef (backward compatible with older calls).
    if (data && typeof data === "object" && deviceRef === null) {
      this.deviceRef = data;
      this.data = "";
    } else {
      this.deviceRef = deviceRef;
      this.data = data ?? "";
    }

    this.name = "";
  }

  setTargetValue(targetValue) {
    if (targetValue === true) targetValue = 1;
    else if (targetValue === false) targetValue = 0;
    this.target_value = targetValue;
  }

  setCurrentValue(currentValue) {
    if (currentValue === true) currentValue = 1;
    else if (currentValue === false) currentValue = 0;
    this.current_value = currentValue;
  }
}
