/** @type {Map<string, import("./_base.js").Machine>} */
const machines = new Map();

export function registerMachine(machine) {
  machines.set(machine.name, machine);
}

export function getMachine(name) {
  const machine = machines.get(name);
  if (!machine) {
    throw new Error(`Unknown machine: ${name}`);
  }
  return machine;
}

export function listMachines() {
  return [...machines.values()];
}

export function hasMachine(name) {
  return machines.has(name);
}

export function clearMachines() {
  machines.clear();
}
