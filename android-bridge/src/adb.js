import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function buildBaseArgs(config) {
  const args = [];
  if (config.serial) args.push('-s', config.serial);
  return args;
}

export async function adb(config, ...args) {
  const commandArgs = [...buildBaseArgs(config), ...args];
  const { stdout, stderr } = await execFileAsync(config.adbPath, commandArgs, { timeout: 20000 });
  return { stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
}

export async function listDevices(config) {
  const { stdout } = await adb(config, 'devices');
  const lines = stdout.split(/\r?\n/).slice(1).filter(Boolean);
  return lines.map((line) => {
    const [serial, status] = line.split(/\s+/);
    return { serial, status };
  });
}

export async function wakeDevice(config) {
  return adb(config, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
}

export async function unlockSwipe(config) {
  return adb(config, 'shell', 'input', 'swipe', '300', '1000', '300', '300');
}

export async function placeCall(config, phone) {
  return adb(config, 'shell', 'am', 'start', '-a', 'android.intent.action.CALL', '-d', `tel:${phone}`);
}

export async function openDialer(config, phone) {
  return adb(config, 'shell', 'am', 'start', '-a', 'android.intent.action.DIAL', '-d', `tel:${phone}`);
}

export async function sendHelperBroadcast(config, phone) {
  return adb(
    config,
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.pedivoy.callhelper.CALL',
    '-n',
    'com.pedivoy.callhelper/.CallCommandReceiver',
    '--es',
    'phone',
    phone,
  );
}

export async function endCall(config) {
  return adb(config, 'shell', 'input', 'keyevent', 'KEYCODE_ENDCALL');
}
