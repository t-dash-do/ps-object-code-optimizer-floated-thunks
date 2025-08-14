function floatedBinding(init) {
  let get = () => {
    const v = init();
    get = () => v;
    return v;
  };
  return () => get();
}
// floating an expression
function add(x) {
  return function (y) {
    return x + y;
  };
}
function main(x) {
  return function (y) {
    const add_y__fb = floatedBinding(() => add(x)(y));
    return function (z) {
      return add_y__fb() + z;
    };
  };
}
