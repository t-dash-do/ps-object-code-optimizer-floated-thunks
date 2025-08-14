// Basic const
function add(x) {
    return function (y) {
        return x + y;
    };
}
function main(x) {
  return function (y) {
    return function (z) {
        const xy = add(x)(y);
        return add(xy)(z);
    };
  };
}
