import type { SerialPortInfo } from "../types/workbench";

export interface SerialPortBinding {
  vid: number;
  pid: number;
  serialNumber: string;
  usbInterface?: number | null;
  location?: string;
}

export function portHasName(port: SerialPortInfo, name: string): boolean {
  return port.port_name === name || (port.aliases?.includes(name) ?? false);
}

export function readSerialPortBinding(port: SerialPortInfo | undefined): SerialPortBinding | undefined {
  if (port?.vid == null || port.pid == null) return undefined;
  return {
    vid: port.vid,
    pid: port.pid,
    serialNumber: port.serial_number,
    usbInterface: port.usb_interface,
    location: port.aliases?.find((path) => path.startsWith("/dev/serial/by-path/")),
  };
}

export function findSerialPort(
  ports: SerialPortInfo[], name: string, binding?: SerialPortBinding,
): SerialPortInfo | undefined {
  if (!binding) return ports.find((port) => portHasName(port, name));

  const matches = ports.filter((port) => port.vid === binding.vid && port.pid === binding.pid &&
    port.serial_number === binding.serialNumber &&
    (binding.usbInterface == null || port.usb_interface === binding.usbInterface));
  if (binding.serialNumber && matches.length === 1) return matches[0];
  const location = binding.location;
  if (location) return matches.find((port) => portHasName(port, location));
  if (!binding.serialNumber) return matches.find((port) => portHasName(port, name));
  return undefined;
}
