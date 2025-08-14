function floatedBinding(init) {
  let get = () => {
    const v = init();
    get = () => v;
    return v;
  };
  return () => get();
}
// Basic const
function add(x) {
  return function (y) {
    return x + y;
  };
}
function main(x) {
  return function (y) {
    const xy__fb = floatedBinding(() => add(x)(y));
    return function (z) {
      const xy = xy__fb();
      return add(xy)(z);
    };
  };
}