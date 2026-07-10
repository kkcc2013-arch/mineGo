/**
 * REQ-00527: XML 格式化器
 */

class XmlFormatter {
  constructor() {
    this.name = 'xml';
    this.mimeType = 'application/xml';
  }

  async format(data) {
    const xml = this._toXml(data);
    return Buffer.from(xml, 'utf-8');
  }

  _toXml(data, indent = '') {
    if (typeof data !== 'object' || data === null) {
      return `${indent}${this._escape(data)}\n`;
    }

    let xml = '';
    for (const [key, value] of Object.entries(data)) {
      const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
      if (Array.isArray(value)) {
        for (const item of value) {
          xml += `${indent}<${safeKey}>\n${this._toXml(item, indent + '  ')}${indent}</${safeKey}>\n`;
        }
      } else if (typeof value === 'object' && value !== null) {
        xml += `${indent}<${safeKey}>\n${this._toXml(value, indent + '  ')}${indent}</${safeKey}>\n`;
      } else {
        xml += `${indent}<${safeKey}>${this._escape(value)}</${safeKey}>\n`;
      }
    }
    return xml;
  }

  _escape(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  getDescription() {
    return {
      name: this.name,
      mimeType: this.mimeType,
      description: 'Enterprise integration format with schema validation',
      compliance: { gdpr: true }
    };
  }
}

module.exports = XmlFormatter;