/**
 * 文本相似度计算工具
 */

/**
 * 计算两个文本的 Jaccard 相似度
 */
function jaccardSimilarity(text1, text2) {
  const tokens1 = new Set(tokenize(text1));
  const tokens2 = new Set(tokenize(text2));

  if (tokens1.size === 0 || tokens2.size === 0) {
    return 0;
  }

  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);

  return intersection.size / union.size;
}

/**
 * 计算两个文本的余弦相似度
 */
function cosineSimilarity(text1, text2) {
  const tokens1 = tokenize(text1);
  const tokens2 = tokenize(text2);

  if (tokens1.length === 0 || tokens2.length === 0) {
    return 0;
  }

  // 构建 TF 向量
  const allTokens = new Set([...tokens1, ...tokens2]);
  const tf1 = {};
  const tf2 = {};

  for (const token of allTokens) {
    tf1[token] = tokens1.filter(t => t === token).length / tokens1.length;
    tf2[token] = tokens2.filter(t => t === token).length / tokens2.length;
  }

  // 计算点积和模
  let dotProduct = 0;
  let magnitude1 = 0;
  let magnitude2 = 0;

  for (const token of allTokens) {
    dotProduct += tf1[token] * tf2[token];
    magnitude1 += tf1[token] * tf1[token];
    magnitude2 += tf2[token] * tf2[token];
  }

  magnitude1 = Math.sqrt(magnitude1);
  magnitude2 = Math.sqrt(magnitude2);

  if (magnitude1 === 0 || magnitude2 === 0) {
    return 0;
  }

  return dotProduct / (magnitude1 * magnitude2);
}

/**
 * 计算 Levenshtein 编辑距离
 */
function levenshteinDistance(text1, text2) {
  const m = text1.length;
  const n = text2.length;

  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (text1[i - 1] === text2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,     // 删除
          dp[i][j - 1] + 1,     // 插入
          dp[i - 1][j - 1] + 1  // 替换
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * 计算编辑距离相似度
 */
function editDistanceSimilarity(text1, text2) {
  const distance = levenshteinDistance(text1, text2);
  const maxLength = Math.max(text1.length, text2.length);
  
  if (maxLength === 0) return 1;
  
  return 1 - distance / maxLength;
}

/**
 * 综合相似度计算
 */
function similarity(text1, text2, options = {}) {
  const {
    method = 'cosine',  // 'cosine', 'jaccard', 'edit', 'combined'
    weights = { cosine: 0.4, jaccard: 0.4, edit: 0.2 }
  } = options;

  if (!text1 || !text2) {
    return 0;
  }

  switch (method) {
    case 'cosine':
      return cosineSimilarity(text1, text2);
    case 'jaccard':
      return jaccardSimilarity(text1, text2);
    case 'edit':
      return editDistanceSimilarity(text1, text2);
    case 'combined':
      return (
        weights.cosine * cosineSimilarity(text1, text2) +
        weights.jaccard * jaccardSimilarity(text1, text2) +
        weights.edit * editDistanceSimilarity(text1, text2)
      );
    default:
      return cosineSimilarity(text1, text2);
  }
}

/**
 * 分词
 */
function tokenize(text) {
  if (!text) return [];
  
  return text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 2);
}

/**
 * 提取关键词
 */
function extractKeywords(text, limit = 10) {
  const tokens = tokenize(text);
  const frequency = {};

  for (const token of tokens) {
    frequency[token] = (frequency[token] || 0) + 1;
  }

  return Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

module.exports = {
  similarity,
  cosineSimilarity,
  jaccardSimilarity,
  editDistanceSimilarity,
  levenshteinDistance,
  tokenize,
  extractKeywords
};
