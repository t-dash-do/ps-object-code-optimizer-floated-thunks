// Basic let
function add(x) {
    return function (y) {
        return x + y;
    };
}
function main(x){
  return function (y) {
    return function (z) {
        let xy = add(x)(y);
        return add(xy)(z);
    };
  };
}
