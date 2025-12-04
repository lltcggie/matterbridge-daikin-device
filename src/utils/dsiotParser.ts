/**
 * Copyright 2025 lltcggie
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

function parseSignedHex(hex: string, bytes: number): number {
  const num = parseInt(hex, 16);
  const bits = bytes * 8;
  const shift = 32 - bits;
  return (num << shift) >> shift;
}

function toSignedHex(num: number, bytes: number): string {
  const hex = (num >>> 0).toString(16).toUpperCase();
  const targetLength = bytes * 2;
  return hex.padStart(targetLength, '0').slice(-targetLength);
}

function decodePvToInt(data: any[] | undefined): number {
  if (data === undefined) {
    throw new Error('decodePvToInt(): data is undefined');
  }
  const decimalValue = decodePv(data[0], data[1]);
  return Math.trunc(decimalValue);
}

function decodePvToFloat(data: any[] | undefined): number {
  if (data === undefined) {
    throw new Error('decodePvToFloat(): data is undefined');
  }
  const decimalValue = decodePv(data[0], data[1]);
  return decimalValue;
}

function decodePv(pv: string, md: { st: number }): number {
  const swapped = convertEndian(pv);
  const base = parseSignedHex(swapped, swapped.length / 2);
  const step = decodeStepValue(md.st);
  return step === 0 ? base : base * step;
}

function encodeIntToPv(data: any[] | undefined): string {
  if (data === undefined) {
    throw new Error('encodeIntToPv(): data is undefined');
  }
  const value = Math.trunc(data[0]);
  const str = encodePv(value, data[1]);
  return str;
}

function encodeFloatToPv(data: any[] | undefined): string {
  if (data === undefined) {
    throw new Error('encodeFloatToPv(): data is undefined');
  }
  const str = encodePv(data[0], data[1]);
  return str;
}

function encodePv(value: number, md: { st: number; mx: string | null }): string {
  const step = decodeStepValue(md.st);
  const pvNumber = step === 0 ? value : Math.trunc(value / step);
  const pv = md.mx !== null ? toSignedHex(pvNumber, md.mx.length / 2) : '';
  const swapped = convertEndian(pv);
  return swapped;
}

function convertEndian(value: string): string {
  const bytes: string[] = [];
  for (let i = 0; i < value.length; i += 2) {
    bytes.push(value.slice(i, i + 2));
  }
  return bytes.reverse().join('');
}

function decodeStepValue(step: number): number {
  if (step < 0 || step > 0xff) {
    throw new RangeError(String(step));
  }
  const base = step & 0x0f;
  const coefficient = getStepValueCoefficient((step & 0xf0) >> 4);
  return base * coefficient;
}

function getStepValueCoefficient(index: number): number {
  const table = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1];
  if (index < 0 || index >= table.length) {
    throw new RangeError(String(index));
  }
  return table[index];
}

export { decodePvToInt, decodePvToFloat, encodeIntToPv, encodeFloatToPv };
