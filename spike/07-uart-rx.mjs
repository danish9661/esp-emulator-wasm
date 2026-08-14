// Phase 0: does uart_input() surface in UART0's status register to bare-metal code?
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';
const fw = new Uint8Array(readFileSync(new URL('./uart_status.bin', import.meta.url)));
const { emu } = await boot({ chip: 'esp32c3', firmware: fw, bootFromRom: false });
const uniq = s => [...new Set(s.trim().match(/../g) || [])].join(' ');
for (let i = 0; i < 5; i++) emu.run_batch(2000);
console.log('UART_STATUS low byte, idle:      ', uniq(emu.run_batch(3000)));
emu.uart_input(new Uint8Array([0x41, 0x42, 0x43]));
console.log('UART_STATUS after uart_input(3B):', uniq(emu.run_batch(3000)));
