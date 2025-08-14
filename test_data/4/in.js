// Basic var
function add(x) {
    return function (y) {
        return x + y;
    };
}
function main(x){
  return function(y) {
    return function(z) {
        var xy = add(x)(y);
        return add(xy)(z);
    };
  };
}
