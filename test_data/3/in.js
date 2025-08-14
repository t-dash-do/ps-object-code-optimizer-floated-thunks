// floating an expression
function add(x) {
    return function(y){
        return x + y
    }
}


function main(x){
  return function(y) {
    return function(z) {
        return (add(x)(y)) + z
    }
  }
}
