/**
 * Formats tool result data into clean, human-readable text.
 * Only shows raw JSON when user explicitly asks for it.
 */

// Extract localized string from LinkedIn-style locale objects
function extractLocalized(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj.localized) {
    const locale = obj.preferredLocale;
    const key = locale ? `${locale.language}_${locale.country}` : Object.keys(obj.localized)[0];
    return obj.localized[key] || Object.values(obj.localized)[0] || '';
  }
  if (obj.localizedFirstName) return obj.localizedFirstName;
  return '';
}

// Extract value from nested Composio response wrappers
function extractValue(obj) {
  if (!obj) return obj;
  if (typeof obj !== 'object') return obj;
  if (obj.localized) return extractLocalized(obj);
  if (obj.value !== undefined) return obj.value;
  if (obj.displayValue) return obj.displayValue;
  return obj;
}

// Format a single key-value pair for display
function formatField(key, value, indent = '') {
  if (value === null || value === undefined || value === '') return '';

  const label = key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^\w/, c => c.toUpperCase())
    .trim();

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const str = String(value).trim();
    if (!str || str === '{}' || str === '[]') return '';
    return `${indent}${label}: ${str}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    const items = value.map(v => {
      if (typeof v === 'object' && v !== null) {
        return formatObject(v, indent + '  ');
      }
      return `${indent}  - ${v}`;
    }).filter(Boolean);
    if (items.length === 0) return '';
    return `${indent}${label}:\n${items.join('\n')}`;
  }

  if (typeof value === 'object') {
    const formatted = formatObject(value, indent + '  ');
    if (!formatted) return '';
    return `${indent}${label}:\n${formatted}`;
  }

  return '';
}

// Format an object into readable lines
function formatObject(obj, indent = '') {
  if (!obj || typeof obj !== 'object') return String(obj || '');

  const lines = [];

  // Priority order for common fields
  const priorityKeys = [
    'id', 'firstName', 'lastName', 'name', 'title', 'subject',
    'headline', 'email', 'emailAddress', 'sender', 'from',
    'status', 'state', 'dueDate', 'due', 'createdAt', 'updatedAt',
    'body', 'content', 'message', 'text', 'description',
    'profileUrl', 'url', 'link', 'webUrl', 'htmlUrl',
    'profilePicture', 'avatar', 'image'
  ];

  const processedKeys = new Set();

  // First pass: priority keys
  for (const key of priorityKeys) {
    if (obj.hasOwnProperty(key)) {
      const value = extractValue(obj[key]);
      const formatted = formatField(key, value, indent);
      if (formatted) {
        lines.push(formatted);
        processedKeys.add(key);
      }
    }
  }

  // Second pass: remaining keys
  for (const [key, value] of Object.entries(obj)) {
    if (processedKeys.has(key)) continue;
    if (key === 'preferredLocale' || key === 'localized' || key === 'paging') continue;

    const extracted = extractValue(value);
    const formatted = formatField(key, extracted, indent);
    if (formatted) {
      lines.push(formatted);
    }
  }

  return lines.join('\n');
}

// Detect and format specific data types
function formatByType(data, toolName) {
  const str = JSON.stringify(data);

  // LinkedIn profile
  if (str.includes('localizedFirstName') || str.includes('localizedLastName') || str.includes('profileUrl')) {
    const parts = [];
    const firstName = extractLocalized(data.firstName) || data.localizedFirstName || '';
    const lastName = extractLocalized(data.lastName) || data.localizedLastName || '';
    const headline = extractLocalized(data.headline) || data.localizedHeadline || '';

    if (firstName || lastName) parts.push(`Name: ${firstName} ${lastName}`.trim());
    if (headline) parts.push(`Headline: ${headline}`);
    if (data.vanityName) parts.push(`Username: ${data.vanityName}`);
    if (data.profileUrl) parts.push(`Profile: ${data.profileUrl}`);
    if (data.id) parts.push(`ID: ${data.id}`);

    // Profile picture
    if (data.profilePicture?.displayImage) {
      parts.push(`Profile Picture: ${data.profilePicture.displayImage}`);
    }

    if (parts.length > 0) return parts.join('\n');
  }

  // LinkedIn posts
  if (str.includes('ugcPost') || str.includes('shareContent')) {
    return formatObject(data);
  }

  // Gmail send result (has labelIds with SENT, no payload.headers)
  if ((toolName && toolName.toUpperCase().includes('GMAIL_SEND')) || (data.labelIds && Array.isArray(data.labelIds))) {
    const parts = [];
    if (data.labelIds?.includes('SENT')) parts.push('Status: Email sent successfully');
    if (data.id) parts.push(`Message ID: ${data.id}`);
    if (data.threadId) parts.push(`Thread ID: ${data.threadId}`);
    if (data.display_url) parts.push(`View in Gmail: ${data.display_url}`);
    if (parts.length > 0) return parts.join('\n');
  }

  // Gmail messages - metadata only, no private content
  if (str.includes('snippet') || str.includes('payload')) {
    const parts = [];
    const headers = data.payload?.headers || [];
    const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

    const from = getHeader('From');
    const subject = getHeader('Subject');
    const date = getHeader('Date');

    if (from) parts.push(`From: ${from}`);
    if (subject) parts.push(`Subject: ${subject}`);
    if (date) parts.push(`Date: ${date}`);
    if (data.id) parts.push(`ID: ${data.id}`);

    if (parts.length > 0) return parts.join('\n');
  }

  // Google Tasks
  if (str.includes('tasklist') || str.includes('due') || str.includes('completed')) {
    const parts = [];
    if (data.title) parts.push(`Title: ${data.title}`);
    if (data.notes) parts.push(`Notes: ${data.notes}`);
    if (data.due) parts.push(`Due: ${new Date(data.due).toLocaleDateString()}`);
    if (data.status) parts.push(`Status: ${data.status}`);
    if (data.completed) parts.push(`Completed: ${new Date(data.completed).toLocaleDateString()}`);
    if (data.updated) parts.push(`Updated: ${new Date(data.updated).toLocaleDateString()}`);
    if (data.selfLink) parts.push(`Link: ${data.selfLink}`);

    if (parts.length > 0) return parts.join('\n');
  }

  // GitHub issues/PRs
  if (str.includes('pull_request') || str.includes('labels') || str.includes('assignee')) {
    return formatObject(data);
  }

  // Notion pages
  if (str.includes('page_id') || str.includes('properties') || str.includes('parent')) {
    return formatObject(data);
  }

  // Generic array of items
  if (Array.isArray(data)) {
    if (data.length === 0) return 'No results found.';
    return data.map((item, i) => {
      if (typeof item === 'object' && item !== null) {
        const formatted = formatObject(item, '  ');
        return formatted ? `${i + 1}. ${formatted}` : `${i + 1}. ${JSON.stringify(item)}`;
      }
      return `${i + 1}. ${item}`;
    }).join('\n');
  }

  return null;
}

/**
 * Main formatter function
 * @param {any} data - The tool result data
 * @param {string} toolName - The name of the tool that produced this result
 * @returns {string} Human-readable formatted text
 */
export function formatToolResult(data, toolName = '') {
  if (data === null || data === undefined) {
    return 'Operation completed successfully.';
  }

  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return data;
    }
  }

  // Try type-specific formatting first
  const typeFormatted = formatByType(data, toolName);
  if (typeFormatted) return typeFormatted;

  // Fall back to generic object formatting
  if (typeof data === 'object') {
    const formatted = formatObject(data);
    if (formatted) return formatted;
  }

  // Last resort: return as string
  return String(data);
}

/**
 * Format with a header prefix
 */
export function formatToolResultWithHeader(data, toolName, success = true) {
  if (!success) {
    const errorMsg = typeof data === 'string' ? data : JSON.stringify(data);
    return `${toolName} failed: ${errorMsg}`;
  }

  const formatted = formatToolResult(data, toolName);
  return `${toolName} completed successfully.\n\n${formatted}`;
}

export default formatToolResult;
