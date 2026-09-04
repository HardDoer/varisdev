'use strict';

module.exports = [
  {
    ignores: ['build/', 'node_modules/', '.pi/', 'generated-images/'],
  },
  ...require('gts'),
];
