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

import { decodePvToInt, decodePvToFloat, encodeIntToPv, encodeFloatToPv } from './dsiotParser.js';

export class DsiotQuery {
  private responsesData: any;

  constructor(responsesData: any) {
    this.responsesData = responsesData;
  }

  public extractValueString(fr: string, path: string): string | undefined {
    if (this.responsesData === undefined || this.responsesData.hasOwnProperty('responses') === false) {
      return undefined;
    }

    let currentObject = this.responsesData['responses'];
    for (const response of currentObject) {
      if (response['fr'] === fr) {
        currentObject = response['pc']['pch'];
      }
    }

    const pathKeys = path.split('/');
    for (let i = 0; i < pathKeys.length; i++) {
      const key = pathKeys[i];
      for (const currentObjectElement of currentObject) {
        if (currentObjectElement['pn'] === key) {
          if (currentObjectElement.hasOwnProperty('pch')) {
            currentObject = currentObjectElement['pch'];
            break;
          } else if (currentObjectElement.hasOwnProperty('pv')) {
            if (i === pathKeys.length - 1) {
              return currentObjectElement['pv'] as string;
            }
          }
        }
      }
    }

    return undefined;
  }

  public extractValueInt(fr: string, path: string): number | undefined {
    return decodePvToInt(this.extractValueNumber(fr, path));
  }

  public extractValueFloat(fr: string, path: string): number | undefined {
    return decodePvToFloat(this.extractValueNumber(fr, path));
  }

  public extractMinMax(fr: string, path: string): (number | null)[] | undefined {
    const obj = this.extractObject(fr, path);
    if (obj === undefined) {
      return undefined;
    }

    const min = obj['md']['mi'] !== null ? decodePvToFloat([obj['md']['mi'], obj['md']]) : null;
    const max = obj['md']['mx'] !== null ? decodePvToFloat([obj['md']['mx'], obj['md']]) : null;

    return [min, max];
  }

  public encodePvInt(fr: string, path: string, pv: number): any | undefined {
    return this.encodePv(fr, path, pv, encodeIntToPv);
  }

  public encodePvFloat(fr: string, path: string, pv: number): any | undefined {
    return this.encodePv(fr, path, pv, encodeFloatToPv);
  }

  public static combineObject(dst: any, src: any): any {
    for (const i in src) {
      const srcObj = src[i];
      const pn = srcObj['pn'];

      let found = false;
      for (const j in dst) {
        const dstObj = dst[j];
        if (dstObj['pn'] === pn) {
          if (srcObj.hasOwnProperty('pv')) {
            dstObj['pv'] = srcObj['pv'];
            found = true;
            break;
          } else {
            this.combineObject(dstObj['pch'], srcObj['pch']);
            found = true;
            break;
          }
        }
      }

      if (!found) {
        dst.push(srcObj);
      }
    }
    return dst;
  }

  private extractValueNumber(fr: string, path: string): any[] | undefined {
    if (this.responsesData === undefined || this.responsesData.hasOwnProperty('responses') === false) {
      throw new Error(`Daikin - extractValue(${Object}, ${fr}, ${path}): Error: No responses object found`);
    }

    let currentObject = this.responsesData['responses'];
    for (const response of currentObject) {
      if (response['fr'] === fr) {
        currentObject = response['pc']['pch'];
      }
    }

    const pathKeys = path.split('/');
    for (let i = 0; i < pathKeys.length; i++) {
      const key = pathKeys[i];
      for (const currentObjectElement of currentObject) {
        if (currentObjectElement['pn'] === key) {
          if (currentObjectElement.hasOwnProperty('pch')) {
            currentObject = currentObjectElement['pch'];
            break;
          } else if (currentObjectElement.hasOwnProperty('pv') && currentObjectElement.hasOwnProperty('md')) {
            if (i === pathKeys.length - 1) {
              return [currentObjectElement['pv'], currentObjectElement['md']];
            }
          }
        }
      }
    }

    throw new Error('Daikin - extractValue(): Error: No value found for path:' + path);
  }

  private extractObject(fr: string, path: string): any | undefined {
    if (this.responsesData === undefined || this.responsesData.hasOwnProperty('responses') === false) {
      throw new Error('Daikin - extractObject(): Error: No responses object found');
    }

    let currentObject = this.responsesData['responses'];
    for (const response of currentObject) {
      if (response['fr'] === fr) {
        currentObject = response['pc']['pch'];
      }
    }

    const pathKeys = path.split('/');
    for (const key of pathKeys) {
      for (const currentObjectElement of currentObject) {
        if (currentObjectElement['pn'] === key) {
          if (currentObjectElement.hasOwnProperty('pch')) {
            currentObject = currentObjectElement['pch'];
            break;
          } else if (currentObjectElement.hasOwnProperty('pv')) {
            return currentObjectElement;
          }
        }
      }
    }

    throw new Error('Daikin - extractValue(): Error: No value found for path:' + path);
  }

  private encodePv(fr: string, path: string, pv: number, encoder: (data: any[] | undefined) => string): any | undefined {
    if (this.responsesData === undefined || this.responsesData.hasOwnProperty('responses') === false) {
      throw new Error(`Daikin - extractValue(${Object}, ${fr}, ${path}): Error: No responses object found`);
    }

    let currentObject = this.responsesData['responses'];
    for (const response of currentObject) {
      if (response['fr'] === fr) {
        currentObject = response['pc']['pch'];
      }
    }

    const objRoot = [] as any;
    let curObj = objRoot;

    const pathKeys = path.split('/');
    for (let i = 0; i < pathKeys.length; i++) {
      const key = pathKeys[i];
      for (const currentObjectElement of currentObject) {
        if (currentObjectElement['pn'] === key) {
          if (currentObjectElement.hasOwnProperty('pch')) {
            currentObject = currentObjectElement['pch'];

            const obj = { pn: '', pch: [] } as any;
            obj.pn = key;
            curObj.push(obj);
            curObj = obj.pch;
            break;
          } else if (currentObjectElement.hasOwnProperty('pv') && currentObjectElement.hasOwnProperty('md')) {
            if (i === pathKeys.length - 1) {
              const epv = encoder([pv, currentObjectElement['md']]);
              const obj = { pn: '', pv: '' } as any;
              obj.pn = key;
              obj.pv = epv;
              curObj.push(obj);
              return objRoot;
            }
          }
        }
      }
    }

    throw new Error('Daikin - extractValue(): Error: No value found for path:' + path);
  }
}
