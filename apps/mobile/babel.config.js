module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // ethers v6 uses private class methods (#name()), which Expo 49's preset does not transform.
    plugins: [['@babel/plugin-transform-private-methods', { loose: true }]],
  };
};
