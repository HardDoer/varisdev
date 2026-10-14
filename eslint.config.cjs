'use strict';

module.exports = [
  {
    ignores: [
      'build/',
      'desktop/build/',
      'node_modules/',
      '.pi/',
      'generated-images/',
      'generated-audio/',
    ],
  },
  ...require('gts'),
];
