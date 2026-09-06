pub struct Cyfriflyfr {
    cofnodion: Vec<i64>,
}
impl Cyfriflyfr {
    pub fn newydd() -> Self {
        Self { cofnodion: Vec::new() }
    }

    pub fn cofnodi(&mut self, gwerth: i64) {
        self.cofnodion.push(gwerth);
    }

    pub fn cyfanswm(&self) -> i64 {
        self.cofnodion.iter().sum()
    }
}

pub fn prosesu(gwerthoedd: &[i64]) -> i64 {
    let mut llyfr = Cyfriflyfr::newydd();
    for gwerth in gwerthoedd {
        llyfr.cofnodi(*gwerth);
    }
    llyfr.cyfanswm()
}

#[cfg(test)]
mod profion {
    use super::prosesu;

    #[test]
    fn cyfanswm_yw_cywir() {
        assert_eq!(prosesu(&[2, 3, 5]), 10);
    }
}
