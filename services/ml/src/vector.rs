//! Pure vector math shared by both embedding units.

/// Scales `vector` to unit length in place. A zero vector is left as it is
/// rather than turned into NaNs.
pub fn l2_normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|x| f64::from(*x) * f64::from(*x)).sum::<f64>().sqrt();
    if norm == 0.0 {
        return;
    }
    for value in vector.iter_mut() {
        *value = (f64::from(*value) / norm) as f32;
    }
}

/// Mean of each sequence's token vectors, counting only tokens the attention
/// mask marks as real. `hidden` is `[batch, tokens, dim]` and `mask` is
/// `[batch, tokens]`, both row-major.
pub fn mean_pool(hidden: &[f32], mask: &[i64], batch: usize, tokens: usize, dim: usize) -> Option<Vec<Vec<f32>>> {
    if hidden.len() != batch.checked_mul(tokens)?.checked_mul(dim)? || mask.len() != batch * tokens {
        return None;
    }
    let mut pooled = Vec::with_capacity(batch);
    for row in 0..batch {
        let mut sum = vec![0f32; dim];
        let mut count = 0f32;
        for token in 0..tokens {
            if mask[row * tokens + token] == 0 {
                continue;
            }
            count += 1.0;
            let start = (row * tokens + token) * dim;
            for (total, value) in sum.iter_mut().zip(&hidden[start..start + dim]) {
                *total += value;
            }
        }
        if count > 0.0 {
            for total in &mut sum {
                *total /= count;
            }
        }
        pooled.push(sum);
    }
    Some(pooled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_to_unit_length() {
        let mut vector = vec![3.0, 4.0];
        l2_normalize(&mut vector);
        assert!((vector[0] - 0.6).abs() < 1e-6);
        assert!((vector[1] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn leaves_a_zero_vector_alone() {
        let mut vector = vec![0.0, 0.0];
        l2_normalize(&mut vector);
        assert_eq!(vector, vec![0.0, 0.0]);
    }

    #[test]
    fn pools_only_unmasked_tokens() {
        // Two sequences of three tokens, two dimensions; the second sequence has one pad.
        let hidden = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 10.0, 20.0, 30.0, 40.0, 99.0, 99.0];
        let mask = [1, 1, 1, 1, 1, 0];
        let pooled = mean_pool(&hidden, &mask, 2, 3, 2).unwrap();
        assert_eq!(pooled, vec![vec![3.0, 4.0], vec![20.0, 30.0]]);
    }

    #[test]
    fn pooling_a_fully_masked_row_yields_zeros() {
        let pooled = mean_pool(&[1.0, 2.0], &[0], 1, 1, 2).unwrap();
        assert_eq!(pooled, vec![vec![0.0, 0.0]]);
    }

    #[test]
    fn pooling_rejects_mismatched_shapes() {
        assert!(mean_pool(&[1.0, 2.0, 3.0], &[1], 1, 1, 2).is_none());
        assert!(mean_pool(&[1.0, 2.0], &[1, 1], 1, 1, 2).is_none());
    }
}
