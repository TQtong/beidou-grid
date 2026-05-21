export default class StringBuilder { 
  private __stringArr__: string[];
  constructor() {
    this.__stringArr__ = [];
  }
  append(str: string) {
    this.__stringArr__.push(str);
  }
  subString(start: number, end: number): string {
    return this.__stringArr__.slice(start, end).join('');
  }
  toString() {
    return this.__stringArr__.join('');
  }
}